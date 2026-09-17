import {
  AssetBulkUploadCheckItem,
  AssetBulkUploadCheckResult,
  AssetMediaResponseDto,
  AssetMediaStatus,
  AssetRejectReason,
  AssetUploadAction,
  AssetVisibility,
  Permission,
  addAssetsToAlbum,
  checkBulkUpload,
  createAlbum,
  defaults,
  getAllAlbums,
  getSupportedMediaTypes,
} from '@immich/sdk';
import byteSize from 'byte-size';
import { Matcher, watch as watchFs } from 'chokidar';
import { MultiBar, Presets, SingleBar } from 'cli-progress';
import { chunk } from 'lodash-es';
import micromatch from 'micromatch';
import { BigIntStats, Stats, createReadStream, existsSync } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import path, { basename } from 'node:path';
import { HashCache } from 'src/hash-cache.js';
import { Queue } from 'src/queue.js';
import { BaseOptions, Batcher, authenticate, crawl, requirePermissions, s, sha1 } from 'src/utils.js';

const UPLOAD_WATCH_BATCH_SIZE = 100;
const UPLOAD_WATCH_DEBOUNCE_TIME_MS = 10_000;

// TODO figure out why `id` is missing
type AssetBulkUploadCheckResults = Array<AssetBulkUploadCheckResult & { id: string }>;
type Asset = {
  id: string;
  filepath: string;
  /** The checksum sent to the server for this file, when one was computed. */
  checksum?: string;
  /** True when that checksum came from the hash cache rather than from reading the file. */
  fromCache?: boolean;
};
// A file the server refused for a reason other than "we already have it", so there is no
// server-side copy and the local file must not be deleted.
type RejectedFile = { filepath: string; reason?: AssetRejectReason };

export interface UploadOptionsDto {
  recursive?: boolean;
  ignore?: string;
  dryRun?: boolean;
  skipHash?: boolean;
  delete?: boolean;
  deleteDuplicates?: boolean;
  album?: boolean;
  albumName?: string;
  visibility?: AssetVisibility;
  includeHidden?: boolean;
  concurrency: number;
  progress?: boolean;
  watch?: boolean;
  jsonOutput?: boolean;
  /** Set to false by `--no-upload` to check files against the server without uploading them. */
  upload?: boolean;
  /** Set to false by `--no-cache` to hash every file from disk, ignoring the persistent cache. */
  cache?: boolean;
}

// One cache per process: `--watch` calls checkForDuplicates once per batch, and re-reading the log
// each time would undo the saving. Closed on exit, and by closeHashCache() between tests.
const hashCacheSlot: { cache?: HashCache; isResolved: boolean } = { isResolved: false };

const getHashCache = (options: UploadOptionsDto): HashCache | undefined => {
  if (!hashCacheSlot.isResolved) {
    hashCacheSlot.isResolved = true;
    hashCacheSlot.cache = options.cache === false ? undefined : new HashCache();
  }

  return hashCacheSlot.cache;
};

/** Flushes and forgets the process-wide cache. */
export const closeHashCache = () => {
  hashCacheSlot.cache?.close();
  hashCacheSlot.cache = undefined;
  hashCacheSlot.isResolved = false;
};

class UploadFile extends File {
  constructor(
    private filepath: string,
    private _size: number,
  ) {
    super([], basename(filepath));
  }

  // @ts-expect-error size is already a property on the new File interface
  get size() {
    return this._size;
  }

  stream() {
    return createReadStream(this.filepath) as any;
  }
}

const uploadBatch = async (files: string[], options: UploadOptionsDto) => {
  const { newFiles, duplicates, rejects } = await checkForDuplicates(files, options);
  const newAssets = await uploadFiles(newFiles, options);
  if (options.jsonOutput) {
    console.log(JSON.stringify({ newFiles, duplicates, rejects, newAssets }, undefined, 4));
  }
  await updateAlbums([...newAssets, ...duplicates], options);

  await deleteFiles(newAssets, duplicates, options);
};

export const startWatch = async (
  paths: string[],
  options: UploadOptionsDto,
  {
    batchSize = UPLOAD_WATCH_BATCH_SIZE,
    debounceTimeMs = UPLOAD_WATCH_DEBOUNCE_TIME_MS,
  }: { batchSize?: number; debounceTimeMs?: number } = {},
) => {
  const watcherIgnored: Matcher[] = [];
  const { image, video } = await getSupportedMediaTypes();
  const extensions = new Set([...image, ...video]);

  if (options.ignore) {
    watcherIgnored.push((path) => micromatch.contains(path, `**/${options.ignore}`));
  }

  const pathsBatcher = new Batcher<string>({
    batchSize,
    debounceTimeMs,
    onBatch: async (paths: string[]) => {
      const uniquePaths = [...new Set(paths)];
      await uploadBatch(uniquePaths, options);
    },
  });

  const onFile = async (path: string, stats?: Stats) => {
    if (stats?.isDirectory()) {
      return;
    }
    const ext = '.' + path.split('.').pop()?.toLowerCase();
    if (!ext || !extensions.has(ext)) {
      return;
    }

    if (!options.progress) {
      // logging when progress is disabled as it can cause issues with the progress bar rendering
      console.log(`Change detected: ${path}`);
    }
    pathsBatcher.add(path);
  };
  const fsWatcher = watchFs(paths, {
    ignoreInitial: true,
    ignored: watcherIgnored,
    alwaysStat: true,
    awaitWriteFinish: true,
    depth: options.recursive ? undefined : 1,
    persistent: true,
  })
    .on('add', onFile)
    .on('change', onFile)
    .on('error', (error) => console.error(`Watcher error: ${error}`));

  process.on('SIGINT', async () => {
    console.log('Exiting...');
    await fsWatcher.close();
    process.exit();
  });
};

export const upload = async (paths: string[], baseOptions: BaseOptions, options: UploadOptionsDto) => {
  await authenticate(baseOptions);
  await requirePermissions([Permission.AssetUpload]);

  const scanFiles = await scan(paths, options);

  if (scanFiles.length === 0) {
    if (options.watch) {
      console.log('No files found initially.');
    } else {
      console.log('No files found, exiting');
      return;
    }
  }

  if (options.watch) {
    console.log('Watching for changes...');
    await startWatch(paths, options);
    // watcher does not handle the initial scan
    // as the scan() is a more efficient quick start with batched results
  }

  await uploadBatch(scanFiles, options);
};

const scan = async (pathsToCrawl: string[], options: UploadOptionsDto) => {
  const { image, video } = await getSupportedMediaTypes();

  console.log('Crawling for assets...');
  const files = await crawl({
    pathsToCrawl,
    recursive: options.recursive,
    exclusionPattern: options.ignore,
    includeHidden: options.includeHidden,
    extensions: [...image, ...video],
  });

  return files;
};

export const checkForDuplicates = async (files: string[], options: UploadOptionsDto) => {
  const { concurrency, skipHash, progress } = options;
  if (skipHash) {
    console.log('Skipping hash check, assuming all files are new');
    return { newFiles: files, duplicates: [], rejects: [] };
  }

  const cache = getHashCache(options);

  let multiBar: MultiBar | undefined;
  let totalSize = 0;
  // Stats are taken with bigint precision because the cache keys on nanosecond mtime, device and
  // inode, none of which survive the default number-typed Stats intact.
  const statsMap = new Map<string, BigIntStats>();

  // Calculate total size first
  for (const filepath of files) {
    const stats = await stat(filepath, { bigint: true });
    statsMap.set(filepath, stats);
    totalSize += Number(stats.size);
  }

  if (progress) {
    multiBar = new MultiBar(
      {
        format: '{message} | {bar} | {percentage}% | ETA: {eta_formatted} | {value}/{total}',
        formatValue: (v: number, options, type) => {
          // Don't format percentage
          if (type === 'percentage') {
            return v.toString();
          }
          return byteSize(v).toString();
        },
        etaBuffer: 100, // Increase samples for ETA calculation
      },
      Presets.shades_classic,
    );

    // Ensure we restore cursor on interrupt
    process.on('SIGINT', () => {
      if (multiBar) {
        multiBar.stop();
      }
      process.exit(0);
    });
  } else {
    console.log(`Received ${files.length} files (${byteSize(totalSize)}), hashing...`);
  }

  const hashProgressBar = multiBar?.create(totalSize, 0, {
    message: 'Hashing files          ',
  });
  const checkProgressBar = multiBar?.create(totalSize, 0, {
    message: 'Checking for duplicates',
  });

  const newFiles: string[] = [];
  const duplicates: Asset[] = [];
  const rejects: RejectedFile[] = [];
  // Remembered so that a duplicate can be re-verified before it is unlinked.
  const checksums = new Map<string, { checksum: string; fromCache: boolean }>();

  const checkBulkUploadQueue = new Queue<AssetBulkUploadCheckItem[], void>(
    async (assets: AssetBulkUploadCheckItem[]) => {
      const response = await checkBulkUpload({ assetBulkUploadCheckDto: { assets } });

      const results = response.results as AssetBulkUploadCheckResults;

      for (const { id: filepath, assetId, action, reason } of results) {
        if (action === AssetUploadAction.Accept) {
          newFiles.push(filepath);
        } else if (reason === AssetRejectReason.Duplicate && assetId) {
          // only a confirmed duplicate with a known asset id is safe to delete locally
          duplicates.push({ id: assetId, filepath, ...checksums.get(filepath) });
        } else {
          // anything else (an unsupported format, or a reason this version does not know
          // about) has no copy on the server, so it is reported but never deleted
          rejects.push({ filepath, reason });
        }
      }

      // Update progress based on total size of processed files
      let processedSize = 0;
      for (const asset of assets) {
        const stats = statsMap.get(asset.id);
        processedSize += Number(stats?.size ?? 0);
      }
      checkProgressBar?.increment(processedSize);
    },
    { concurrency, retry: 3 },
  );

  const results: { id: string; checksum: string }[] = [];
  let checkBulkUploadRequests: AssetBulkUploadCheckItem[] = [];

  const queue = new Queue<string, AssetBulkUploadCheckItem[]>(
    async (filepath: string): Promise<AssetBulkUploadCheckItem[]> => {
      const stats = statsMap.get(filepath);
      if (!stats) {
        throw new Error(`Stats not found for ${filepath}`);
      }
      const cached = cache?.get(stats);
      const checksum = cached ?? (await sha1(filepath));
      if (!cached) {
        cache?.set(stats, checksum);
      }

      const dto = { id: filepath, checksum };
      checksums.set(filepath, { checksum, fromCache: cached !== undefined });

      results.push(dto);
      checkBulkUploadRequests.push(dto);
      if (checkBulkUploadRequests.length === 5000) {
        const batch = checkBulkUploadRequests;
        checkBulkUploadRequests = [];
        void checkBulkUploadQueue.push(batch);
      }

      hashProgressBar?.increment(Number(stats.size));
      return results;
    },
    { concurrency, retry: 3 },
  );

  for (const item of files) {
    void queue.push(item);
  }

  await queue.drained();

  if (checkBulkUploadRequests.length > 0) {
    void checkBulkUploadQueue.push(checkBulkUploadRequests);
  }

  await checkBulkUploadQueue.drained();

  multiBar?.stop();

  console.log(`Found ${newFiles.length} new files and ${duplicates.length} duplicate${s(duplicates.length)}`);

  if (cache && cache.hits + cache.misses > 0) {
    const total = cache.hits + cache.misses;
    console.log(
      `Hash cache: ${cache.hits}/${total} file${s(total)} reused (${byteSize(cache.hitBytes)} not re-read), ${cache.misses} hashed`,
    );
  }

  if (rejects.length > 0) {
    console.log(
      `The server rejected ${rejects.length} file${s(rejects.length)}, which will not be uploaded or deleted:`,
    );
    for (const { filepath, reason } of rejects) {
      console.log(`- ${filepath} - ${reason ?? 'unknown reason'}`);
    }
  }

  // Report failures
  const failedTasks = queue.tasks.filter((task) => task.status === 'failed');
  if (failedTasks.length > 0) {
    console.log(`Failed to verify ${failedTasks.length} file${s(failedTasks.length)}:`);
    for (const task of failedTasks) {
      console.log(`- ${task.data} - ${task.error}`);
    }
  }

  return { newFiles, duplicates, rejects };
};

export const uploadFiles = async (files: string[], options: UploadOptionsDto): Promise<Asset[]> => {
  const { dryRun, concurrency, progress, upload } = options;
  if (upload === false) {
    console.log(`Not uploading ${files.length} new asset${s(files.length)}, they have been left in place`);
    return [];
  }

  if (files.length === 0) {
    console.log('All assets were already uploaded, nothing to do.');
    return [];
  }

  // Compute total size first
  let totalSize = 0;
  const statsMap = new Map<string, Stats>();
  for (const filepath of files) {
    const stats = await stat(filepath);
    statsMap.set(filepath, stats);
    totalSize += stats.size;
  }

  if (dryRun) {
    console.log(`Would have uploaded ${files.length} asset${s(files.length)} (${byteSize(totalSize)})`);
    return files.map((filepath) => ({ id: '', filepath }));
  }

  let uploadProgress: SingleBar | undefined;

  if (progress) {
    uploadProgress = new SingleBar(
      {
        format: 'Uploading assets | {bar} | {percentage}% | ETA: {eta_formatted} | {value_formatted}/{total_formatted}',
      },
      Presets.shades_classic,
    );
  } else {
    console.log(`Uploading ${files.length} asset${s(files.length)} (${byteSize(totalSize)})`);
  }
  uploadProgress?.start(totalSize, 0);
  uploadProgress?.update({ value_formatted: 0, total_formatted: byteSize(totalSize) });

  let duplicateCount = 0;
  let duplicateSize = 0;
  let successCount = 0;
  let successSize = 0;

  const newAssets: Asset[] = [];

  const queue = new Queue<string, AssetMediaResponseDto>(
    async (filepath: string) => {
      const stats = statsMap.get(filepath);
      if (!stats) {
        throw new Error(`Stats not found for ${filepath}`);
      }

      const response = await uploadFile(filepath, stats, options);
      newAssets.push({ id: response.id, filepath });
      if (response.status === AssetMediaStatus.Duplicate) {
        duplicateCount++;
        duplicateSize += stats.size ?? 0;
      } else {
        successCount++;
        successSize += stats.size ?? 0;
      }

      uploadProgress?.update(successSize, { value_formatted: byteSize(successSize + duplicateSize) });

      return response;
    },
    { concurrency, retry: 3 },
  );

  for (const item of files) {
    void queue.push(item);
  }

  await queue.drained();

  uploadProgress?.stop();

  console.log(`Successfully uploaded ${successCount} new asset${s(successCount)} (${byteSize(successSize)})`);
  if (duplicateCount > 0) {
    console.log(`Skipped ${duplicateCount} duplicate asset${s(duplicateCount)} (${byteSize(duplicateSize)})`);
  }

  // Report failures
  const failedTasks = queue.tasks.filter((task) => task.status === 'failed');
  if (failedTasks.length > 0) {
    console.log(`Failed to upload ${failedTasks.length} asset${s(failedTasks.length)}:`);
    for (const task of failedTasks) {
      console.log(`- ${task.data} - ${task.error}`);
    }
  }

  return newAssets;
};

const uploadFile = async (
  input: string,
  stats: Stats,
  { visibility }: UploadOptionsDto,
): Promise<AssetMediaResponseDto> => {
  const { baseUrl, headers } = defaults;

  const formData = new FormData();
  formData.append('fileCreatedAt', stats.mtime.toISOString());
  formData.append('fileModifiedAt', stats.mtime.toISOString());
  formData.append('fileSize', String(stats.size));
  formData.append('isFavorite', 'false');
  formData.append('assetData', new UploadFile(input, stats.size));
  if (visibility) {
    formData.append('visibility', visibility);
  }

  const sidecarPath = findSidecar(input);
  if (sidecarPath) {
    try {
      const stats = await stat(sidecarPath);
      const sidecarData = new UploadFile(sidecarPath, stats.size);
      formData.append('sidecarData', sidecarData);
    } catch {
      // noop
    }
  }

  const response = await fetch(`${baseUrl}/assets`, {
    method: 'post',
    redirect: 'error',
    headers: headers as Record<string, string>,
    body: formData,
    // eslint-disable-next-line unicorn/no-null
    window: null,
  });
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(await response.text());
  }

  return response.json() as Promise<AssetMediaResponseDto>;
};

export const findSidecar = (filepath: string): string | undefined => {
  const assetPath = path.parse(filepath);
  const noExtension = path.join(assetPath.dir, assetPath.name);

  // XMP sidecars can come in two filename formats. For a photo named photo.ext, the filenames are photo.ext.xmp and photo.xmp
  for (const sidecarPath of [`${noExtension}.xmp`, `${filepath}.xmp`]) {
    if (existsSync(sidecarPath)) {
      return sidecarPath;
    }
  }
};

/**
 * Re-hashes duplicates whose checksum came from the cache, immediately before they are unlinked,
 * and drops any whose contents no longer match what was sent to the server.
 *
 * This is the safety net that makes the cache usable at all. A cached checksum is a claim that the
 * server already holds these bytes; if the file changed without its size or nanosecond mtime
 * changing — `touch -r`, `rsync --times`, a coarse-grained filesystem — acting on that claim
 * unlinks the only copy of data the server has never seen, with no quarantine and no undo.
 *
 * It is cheap where it matters. On a re-run the duplicates have already been deleted, so what
 * remains is mostly new files, which are never re-read here. Files hashed during this run are not
 * re-read either: their checksum came from the very bytes about to be deleted.
 */
const verifyDuplicates = async (duplicates: Asset[], options: UploadOptionsDto): Promise<Asset[]> => {
  const suspect = duplicates.filter((asset) => asset.fromCache && asset.checksum);
  if (suspect.length === 0) {
    return duplicates;
  }

  const cache = getHashCache(options);
  const stale: Array<{ filepath: string; reason: string }> = [];

  for (const batch of chunk(suspect, options.concurrency)) {
    await Promise.all(
      batch.map(async (asset: Asset) => {
        try {
          const stats = await stat(asset.filepath, { bigint: true });
          const checksum = await sha1(asset.filepath);
          if (checksum === asset.checksum) {
            return;
          }

          // The cached entry was wrong. Replace it with the truth so the next run starts clean.
          cache?.set(stats, checksum);
          stale.push({ filepath: asset.filepath, reason: 'contents changed since it was hashed' });
        } catch (error) {
          stale.push({ filepath: asset.filepath, reason: `could not be re-read (${error})` });
        }
      }),
    );
  }

  if (stale.length === 0) {
    return duplicates;
  }

  const staleFiles = new Set(stale.map(({ filepath }) => filepath));
  console.log(
    `WARNING: the hash cache was stale for ${stale.length} file${s(stale.length)}, which will NOT be deleted:`,
  );
  for (const { filepath, reason } of stale) {
    console.log(`- ${filepath} - ${reason}`);
  }
  console.log(
    'The server does not hold the current contents of these files. Run the upload again to send them, and consider --no-cache if this keeps happening.',
  );

  return duplicates.filter((asset) => !staleFiles.has(asset.filepath));
};

export const deleteFiles = async (uploaded: Asset[], duplicates: Asset[], options: UploadOptionsDto): Promise<void> => {
  if (options.deleteDuplicates && !options.dryRun) {
    // Only worth doing when a stale hit would actually destroy something; without a delete flag
    // the worst a stale hit can cost is an unnecessary upload.
    duplicates = await verifyDuplicates(duplicates, options);
  }

  let fileCount = 0;
  if (options.delete) {
    fileCount += uploaded.length;
  }

  if (options.deleteDuplicates) {
    fileCount += duplicates.length;
  }

  if (options.dryRun) {
    console.log(`Would have deleted ${fileCount} local asset${s(fileCount)}`);
    return;
  }

  if (fileCount === 0) {
    return;
  }

  console.log('Deleting assets that have been uploaded...');
  const deletionProgress = new SingleBar(
    { format: 'Deleting local assets | {bar} | {percentage}% | ETA: {eta}s | {value}/{total} assets' },
    Presets.shades_classic,
  );
  deletionProgress.start(fileCount, 0);

  const chunkDelete = async (files: Asset[]) => {
    for (const assetBatch of chunk(files, options.concurrency)) {
      await Promise.all(
        assetBatch.map(async (input: Asset) => {
          await unlink(input.filepath);
          const sidecarPath = findSidecar(input.filepath);
          if (sidecarPath) {
            await unlink(sidecarPath);
          }
        }),
      );
      deletionProgress.update(assetBatch.length);
    }
  };

  try {
    if (options.delete) {
      await chunkDelete(uploaded);
    }

    if (options.deleteDuplicates) {
      await chunkDelete(duplicates);
    }
  } finally {
    deletionProgress.stop();
  }
};

const updateAlbums = async (assets: Asset[], options: UploadOptionsDto) => {
  if (!options.album && !options.albumName) {
    return;
  }
  const { dryRun, concurrency } = options;

  const albums = await getAllAlbums({});
  const existingAlbums = new Map(albums.map((album) => [album.albumName, album.id]));
  const newAlbums: Set<string> = new Set();
  for (const { filepath } of assets) {
    const albumName = getAlbumName(filepath, options);
    if (albumName && !existingAlbums.has(albumName)) {
      newAlbums.add(albumName);
    }
  }

  if (dryRun) {
    // TODO print asset counts for new albums
    console.log(`Would have created ${newAlbums.size} new album${s(newAlbums.size)}`);
    console.log(`Would have updated albums of ${assets.length} asset${s(assets.length)}`);
    return;
  }

  const progressBar = new SingleBar(
    { format: 'Creating albums | {bar} | {percentage}% | ETA: {eta}s | {value}/{total} albums' },
    Presets.shades_classic,
  );
  progressBar.start(newAlbums.size, 0);

  try {
    for (const albumNames of chunk([...newAlbums], concurrency)) {
      const items = await Promise.all(
        albumNames.map((albumName: string) => createAlbum({ createAlbumDto: { albumName } })),
      );
      for (const { id, albumName } of items) {
        existingAlbums.set(albumName, id);
      }
      progressBar.increment(albumNames.length);
    }
  } finally {
    progressBar.stop();
  }

  console.log(`Successfully created ${newAlbums.size} new album${s(newAlbums.size)}`);
  console.log(`Successfully updated ${assets.length} asset${s(assets.length)}`);

  const albumToAssets = new Map<string, string[]>();
  for (const asset of assets) {
    const albumName = getAlbumName(asset.filepath, options);
    if (!albumName) {
      continue;
    }
    const albumId = existingAlbums.get(albumName);
    if (albumId) {
      if (!albumToAssets.has(albumId)) {
        albumToAssets.set(albumId, []);
      }
      albumToAssets.get(albumId)?.push(asset.id);
    }
  }

  const albumUpdateProgress = new SingleBar(
    { format: 'Adding assets to albums | {bar} | {percentage}% | ETA: {eta}s | {value}/{total} assets' },
    Presets.shades_classic,
  );
  albumUpdateProgress.start(assets.length, 0);

  try {
    for (const [albumId, assets] of albumToAssets) {
      for (const assetBatch of chunk(assets, Math.min(1000 * concurrency, 65_000))) {
        await addAssetsToAlbum({ id: albumId, bulkIdsDto: { ids: assetBatch } });
        albumUpdateProgress.increment(assetBatch.length);
      }
    }
  } finally {
    albumUpdateProgress.stop();
  }
};

// `filepath` valid format:
// - Windows: `D:\\test\\Filename.txt` or `D:/test/Filename.txt`
// - Unix: `/test/Filename.txt`
export const getAlbumName = (filepath: string, options: UploadOptionsDto) => {
  return options.albumName ?? path.basename(path.dirname(filepath));
};
