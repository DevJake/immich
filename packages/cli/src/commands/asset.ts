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

/** Checksums per `/assets/bulk-upload-check` request in steady state. */
const BULK_UPLOAD_CHECK_BATCH_SIZE = 5000;

/**
 * How long a partial batch of checksums may sit idle before it is sent anyway.
 *
 * A full batch is still sent the instant it fills, so a producer fast enough to keep the batcher
 * busy goes on sending 5,000-entry requests and the request count against the server is unchanged.
 * This only releases the tail, and files being hashed more slowly than the interval — which is
 * exactly the case where waiting for 5,000 of them would leave the network idle for minutes.
 */
const BULK_UPLOAD_CHECK_IDLE_MS = 1000;

/**
 * How many files may sit on the upload queue, per concurrent upload, before hashing is held back.
 *
 * Without a bound, a disk that hashes at ~370 MB/s would run thousands of files ahead of a slow
 * uplink and hold every one of their stat records in memory. Uploading is still bounded by
 * `--concurrency` alone; this bounds only the hand-off queue in front of it.
 */
const UPLOAD_BACKLOG_FACTOR = 4;

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

const createMultiBar = () => {
  const multiBar = new MultiBar(
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
    multiBar.stop();
    process.exit(0);
  });

  return multiBar;
};

type UploadFailure = { filepath: string; error: unknown };

/** All an upload needs to know about a file. `Stats` satisfies it, and so does a converted `BigIntStats`. */
type UploadStats = { mtime: Date; size: number };

/**
 * Uploads files as they are handed over, instead of waiting for a complete list of them.
 *
 * `checkForDuplicates` calls {@link add} each time a bulk-upload-check request comes back, so
 * uploading overlaps hashing rather than following it. Request concurrency is unchanged: one
 * `Queue` with the same `--concurrency` bound and the same `retry: 3` as before. Only the moment
 * the first upload leaves is different.
 */
export class Uploader {
  private readonly queue: Queue<string, AssetMediaResponseDto>;
  private readonly statsMap = new Map<string, UploadStats>();
  private readonly accepted: string[] = [];
  private readonly newAssets: Asset[] = [];
  private readonly failures: UploadFailure[] = [];
  private readonly waiters: Array<() => void> = [];
  private readonly maxPending: number;
  private readonly uploading: boolean;

  private progress?: SingleBar;
  private pending = 0;
  private totalSize = 0;
  private duplicateCount = 0;
  private duplicateSize = 0;
  private successCount = 0;
  private successSize = 0;

  constructor(
    private readonly options: UploadOptionsDto,
    private readonly bars?: MultiBar,
  ) {
    const concurrency = Math.max(1, Number(options.concurrency) || 1);
    this.uploading = options.upload !== false && !options.dryRun;
    this.maxPending = concurrency * UPLOAD_BACKLOG_FACTOR;
    this.queue = new Queue<string, AssetMediaResponseDto>((filepath) => this.uploadOne(filepath), {
      concurrency: options.concurrency,
      retry: 3,
    });
  }

  /** True while the hand-off queue is at its bound and hashing should wait. */
  get saturated(): boolean {
    return this.uploading && this.pending >= this.maxPending;
  }

  /** Files currently queued or in flight. */
  get pendingCount(): number {
    return this.pending;
  }

  /**
   * Resolves once the upload queue has room again. Hashing awaits this before each file, so a
   * fast disk cannot build an unbounded backlog in front of a slow uplink.
   */
  async waitForCapacity(): Promise<void> {
    while (this.saturated) {
      const { promise, resolve } = Promise.withResolvers<void>();
      this.waiters.push(resolve);
      await promise;
    }
  }

  /**
   * Waits for room and then claims it. The claim happens in the same tick as the last check, with
   * no await between, so two callers cannot both read "not saturated" and both take the last slot.
   */
  private async acquire(): Promise<void> {
    await this.waitForCapacity();
    this.pending += 1;
  }

  /**
   * Hands over a batch of files the server has accepted. Never throws: it is called from inside the
   * bulk-upload-check queue worker, where a rejection would retry — and so re-send — the whole
   * check request.
   */
  async add(filepaths: string[], statsFor?: (filepath: string) => UploadStats | undefined): Promise<void> {
    if (this.options.upload === false) {
      // Nothing is read or sent; the files are reported and left exactly where they are.
      this.accepted.push(...filepaths);
      return;
    }

    let queued = 0;
    let batchSize = 0;

    // One pass, not two: each file is queued as soon as its size and mtime are known, so the first
    // request of a batch leaves without waiting on the metadata of the last.
    for (const filepath of filepaths) {
      let stats = statsFor?.(filepath);
      if (!stats) {
        try {
          stats = await stat(filepath);
        } catch (error) {
          this.failures.push({ filepath, error });
          continue;
        }
      }

      this.statsMap.set(filepath, stats);
      this.totalSize += stats.size;
      batchSize += stats.size;
      this.accepted.push(filepath);
      queued += 1;

      if (!this.uploading) {
        continue;
      }

      if (this.options.progress) {
        this.startProgress();
        this.render();
      }

      await this.acquire();
      // The queue records its own failures, so this settles either way; catch keeps a surprise
      // rejection from becoming an unhandled one, and the slot is freed in both cases.
      void this.queue
        .push(filepath)
        .catch(() => {})
        .then(() => this.release());
    }

    if (this.uploading && queued > 0 && !this.options.progress) {
      console.log(`Uploading ${queued} asset${s(queued)} (${byteSize(batchSize)})`);
    }
  }

  /** Waits for every accepted file to have been uploaded, or to have exhausted its retries. */
  async drain(): Promise<void> {
    if (this.uploading) {
      await this.queue.drained();
    }

    if (!this.bars) {
      this.progress?.stop();
    }
  }

  /** Prints the summary and returns the assets the server confirmed. Call after {@link drain}. */
  report(): Asset[] {
    if (this.options.upload === false) {
      console.log(
        `Not uploading ${this.accepted.length} new asset${s(this.accepted.length)}, they have been left in place`,
      );
      return [];
    }

    if (this.accepted.length === 0 && this.failures.length === 0) {
      console.log('All assets were already uploaded, nothing to do.');
      return [];
    }

    if (this.options.dryRun) {
      console.log(
        `Would have uploaded ${this.accepted.length} asset${s(this.accepted.length)} (${byteSize(this.totalSize)})`,
      );
      return this.accepted.map((filepath) => ({ id: '', filepath }));
    }

    console.log(
      `Successfully uploaded ${this.successCount} new asset${s(this.successCount)} (${byteSize(this.successSize)})`,
    );
    if (this.duplicateCount > 0) {
      console.log(
        `Skipped ${this.duplicateCount} duplicate asset${s(this.duplicateCount)} (${byteSize(this.duplicateSize)})`,
      );
    }

    // Report failures. A file that could not be read, or whose upload never succeeded, is reported
    // here and is deliberately absent from the returned assets, so --delete never touches it.
    const failed: UploadFailure[] = [
      ...this.failures,
      ...this.queue.tasks
        .filter((task) => task.status === 'failed')
        .map((task) => ({ filepath: task.data, error: task.error })),
    ];
    if (failed.length > 0) {
      console.log(`Failed to upload ${failed.length} asset${s(failed.length)}:`);
      for (const { filepath, error } of failed) {
        console.log(`- ${filepath} - ${error}`);
      }
    }

    return this.newAssets;
  }

  private async uploadOne(filepath: string): Promise<AssetMediaResponseDto> {
    const stats = this.statsMap.get(filepath);
    if (!stats) {
      throw new Error(`Stats not found for ${filepath}`);
    }

    const response = await uploadFile(filepath, stats, this.options);
    this.newAssets.push({ id: response.id, filepath });
    if (response.status === AssetMediaStatus.Duplicate) {
      this.duplicateCount++;
      this.duplicateSize += stats.size ?? 0;
    } else {
      this.successCount++;
      this.successSize += stats.size ?? 0;
    }

    this.render();

    return response;
  }

  private release() {
    this.pending -= 1;

    // Wake everyone, not just the next in line. Hashing and the hand-off both park here, and
    // hashing does not consume a slot when it wakes; waking one at a time let the hashers take
    // every wakeup in turn and left the upload queue starved of work it had room for.
    const waiting = [...this.waiters];
    this.waiters.length = 0;
    for (const resolve of waiting) {
      resolve();
    }
  }

  private startProgress() {
    if (this.progress || !this.options.progress) {
      return;
    }

    if (this.bars) {
      this.progress = this.bars.create(this.totalSize, 0, { message: 'Uploading assets       ' });
      return;
    }

    this.progress = new SingleBar(
      {
        format: 'Uploading assets | {bar} | {percentage}% | ETA: {eta_formatted} | {value_formatted}/{total_formatted}',
      },
      Presets.shades_classic,
    );
    this.progress.start(this.totalSize, 0);
  }

  /** The upload total is only known as files arrive, so it is re-set rather than set once. */
  private render() {
    this.progress?.setTotal(this.totalSize);
    this.progress?.update(this.successSize, {
      value_formatted: byteSize(this.successSize + this.duplicateSize),
      total_formatted: byteSize(this.totalSize),
    });
  }
}

const uploadBatch = async (files: string[], options: UploadOptionsDto) => {
  const bars = options.progress ? createMultiBar() : undefined;
  const uploader = new Uploader(options, bars);
  // Hashing and uploading now share the terminal. Where bars are drawn, the duplicate-check
  // summary is held back rather than printed over them.
  const deferred: string[] = [];

  const check = async () => {
    try {
      return await checkForDuplicates(files, options, {
        bars,
        log: bars
          ? (message: string) => {
              deferred.push(message);
            }
          : undefined,
        onAccepted: (filepaths, statsFor) => uploader.add(filepaths, statsFor),
        onBeforeHash: () => uploader.waitForCapacity(),
      });
    } finally {
      // However the check ended, the upload queue must not be left holding tasks.
      await uploader.drain();
      bars?.stop();
      for (const message of deferred) {
        console.log(message);
      }
    }
  };

  const { newFiles, duplicates, rejects } = await check();
  const newAssets = uploader.report();

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

/**
 * Lets a caller consume the duplicate check as it runs, rather than only when it finishes.
 *
 * Everything here is optional: with an empty context `checkForDuplicates` behaves exactly as it
 * did when it was a self-contained phase, sending one bulk-upload-check request per 5,000 files.
 */
export type DuplicateCheckContext = {
  /**
   * Called with each batch of files the server accepted, as soon as that batch's check returns.
   * `statsFor` hands back the metadata already gathered here, so the consumer need not stat again.
   */
  onAccepted?: (filepaths: string[], statsFor?: (filepath: string) => UploadStats | undefined) => Promise<void>;
  /** Awaited before each file is hashed, so a saturated consumer can hold hashing back. */
  onBeforeHash?: () => Promise<void>;
  /** Progress bars to draw into, when hashing shares the terminal with another phase. */
  bars?: MultiBar;
  /** Where the end-of-phase summary goes. Defaults to the console. */
  log?: (message: string) => void;
  /** Bulk-upload-check flush policy. Overridden by tests; the CLI uses the defaults. */
  batchSize?: number;
  idleMs?: number;
};

export const checkForDuplicates = async (
  files: string[],
  options: UploadOptionsDto,
  context: DuplicateCheckContext = {},
) => {
  const { concurrency, skipHash, progress } = options;
  const log = context.log ?? console.log;
  if (skipHash) {
    log('Skipping hash check, assuming all files are new');
    // No stats were taken on this path, so the uploader takes its own.
    await context.onAccepted?.(files);
    return { newFiles: files, duplicates: [], rejects: [] };
  }

  const cache = getHashCache(options);

  // Bars supplied by the caller are shared with another phase, so they are not ours to stop.
  const isBarsOwner = context.bars === undefined;
  let multiBar: MultiBar | undefined = context.bars;
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
    multiBar ??= createMultiBar();
  } else {
    log(`Received ${files.length} files (${byteSize(totalSize)}), hashing...`);
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

  // Every file has already been stat'd above. Lending those numbers to the uploader saves a second
  // metadata pass over the whole library, which is what used to delay the first upload of a batch.
  const uploadStatsFor = (filepath: string): UploadStats | undefined => {
    const stats = statsMap.get(filepath);
    return stats && { mtime: stats.mtime, size: Number(stats.size) };
  };

  const checkBulkUploadQueue = new Queue<AssetBulkUploadCheckItem[], void>(
    async (assets: AssetBulkUploadCheckItem[]) => {
      const response = await checkBulkUpload({ assetBulkUploadCheckDto: { assets } });

      const results = response.results as AssetBulkUploadCheckResults;
      const accepted: string[] = [];

      for (const { id: filepath, assetId, action, reason } of results) {
        if (action === AssetUploadAction.Accept) {
          newFiles.push(filepath);
          accepted.push(filepath);
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

      // Hand the accepted files over before this worker returns, so that uploading them overlaps
      // the hashing of the files still to come. onAccepted must not throw: this task carries
      // retry: 3, and a rejection here would re-send the whole check request.
      if (accepted.length > 0) {
        await context.onAccepted?.(accepted, uploadStatsFor);
      }
    },
    { concurrency, retry: 3 },
  );

  const results: { id: string; checksum: string }[] = [];

  // Size-or-age flush. A full batch goes out the moment it fills, so a producer fast enough to keep
  // this fed still sends 5,000-entry requests; the idle timer only releases the tail and the
  // slow-producer case, and is armed only when someone is waiting on the results.
  const checkBatcher = new Batcher<AssetBulkUploadCheckItem>({
    batchSize: context.batchSize ?? BULK_UPLOAD_CHECK_BATCH_SIZE,
    debounceTimeMs: context.onAccepted ? (context.idleMs ?? BULK_UPLOAD_CHECK_IDLE_MS) : undefined,
    onBatch: async (batch: AssetBulkUploadCheckItem[]) => {
      void checkBulkUploadQueue.push(batch);
    },
  });

  const queue = new Queue<string, AssetBulkUploadCheckItem[]>(
    async (filepath: string): Promise<AssetBulkUploadCheckItem[]> => {
      // Backpressure: hold hashing back while the consumer is saturated, so the disk cannot run
      // thousands of files ahead of the network.
      await context.onBeforeHash?.();

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
      checkBatcher.add(dto);

      hashProgressBar?.increment(Number(stats.size));
      return results;
    },
    { concurrency, retry: 3 },
  );

  for (const item of files) {
    void queue.push(item);
  }

  await queue.drained();

  // Synchronous, and no items can arrive after the hashing queue has drained, so this both sends
  // the tail and clears the idle timer that would otherwise hold the event loop open.
  checkBatcher.flush();

  await checkBulkUploadQueue.drained();

  if (isBarsOwner) {
    multiBar?.stop();
  }

  log(`Found ${newFiles.length} new files and ${duplicates.length} duplicate${s(duplicates.length)}`);

  if (cache && cache.hits + cache.misses > 0) {
    const total = cache.hits + cache.misses;
    log(
      `Hash cache: ${cache.hits}/${total} file${s(total)} reused (${byteSize(cache.hitBytes)} not re-read), ${cache.misses} hashed`,
    );
  }

  if (rejects.length > 0) {
    log(`The server rejected ${rejects.length} file${s(rejects.length)}, which will not be uploaded or deleted:`);
    for (const { filepath, reason } of rejects) {
      log(`- ${filepath} - ${reason ?? 'unknown reason'}`);
    }
  }

  // Report failures
  const failedTasks = queue.tasks.filter((task) => task.status === 'failed');
  if (failedTasks.length > 0) {
    log(`Failed to verify ${failedTasks.length} file${s(failedTasks.length)}:`);
    for (const task of failedTasks) {
      log(`- ${task.data} - ${task.error}`);
    }
  }

  return { newFiles, duplicates, rejects };
};

/**
 * Uploads a complete list of files. Kept for callers that already hold every file; the pipelined
 * path hands files to an {@link Uploader} in batches as the duplicate check clears them.
 */
export const uploadFiles = async (files: string[], options: UploadOptionsDto): Promise<Asset[]> => {
  const uploader = new Uploader(options);
  await uploader.add(files);
  await uploader.drain();
  return uploader.report();
};

const uploadFile = async (
  input: string,
  stats: UploadStats,
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
