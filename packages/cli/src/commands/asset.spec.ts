import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it, MockedFunction, MockInstance, vi } from 'vitest';

import {
  AssetRejectReason,
  AssetUploadAction,
  AssetVisibility,
  checkBulkUpload,
  defaults,
  getSupportedMediaTypes,
} from '@immich/sdk';
import createFetchMock from 'vitest-fetch-mock';

import {
  checkForDuplicates,
  closeHashCache,
  deleteFiles,
  findSidecar,
  getAlbumName,
  startWatch,
  upload,
  Uploader,
  uploadFiles,
  UploadOptionsDto,
} from 'src/commands/asset';
import type { BaseOptions } from 'src/utils';

vi.mock('@immich/sdk');
vi.mock('src/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/utils')>()),
  authenticate: vi.fn(),
  requirePermissions: vi.fn(),
}));

// Every test gets a throwaway hash cache. Without this the suite would read and write the real
// cache in the developer's home directory.
const hashCacheHome = { directory: '' };
const cacheFilePath = () => path.join(hashCacheHome.directory, 'immich', 'hash-cache.jsonl');

beforeEach(() => {
  hashCacheHome.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'immich-hash-cache-'));
  vi.stubEnv('XDG_CACHE_HOME', hashCacheHome.directory);
  closeHashCache();
});

afterEach(() => {
  closeHashCache();
  vi.unstubAllEnvs();
  fs.rmSync(hashCacheHome.directory, { recursive: true, force: true });
});

describe('getAlbumName', () => {
  it('should return a non-undefined value', () => {
    if (os.platform() === 'win32') {
      // This is meaningless for Unix systems.
      expect(getAlbumName(String.raw`D:\test\Filename.txt`, {} as UploadOptionsDto)).toBe('test');
    }
    expect(getAlbumName('D:/parentfolder/test/Filename.txt', {} as UploadOptionsDto)).toBe('test');
  });

  it('has higher priority to return `albumName` in `options`', () => {
    expect(getAlbumName('/parentfolder/test/Filename.txt', { albumName: 'example' } as UploadOptionsDto)).toBe(
      'example',
    );
  });
});

describe('uploadFiles', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
  const testFilePath = path.join(testDir, 'test.png');
  const testFileData = 'test';
  const baseUrl = 'https://example.com';
  const apiKey = 'key';
  const retry = 3;

  const fetchMocker = createFetchMock(vi);

  beforeEach(() => {
    // Create a test file
    fs.writeFileSync(testFilePath, testFileData);

    // Defaults
    vi.mocked(defaults).baseUrl = baseUrl;
    vi.mocked(defaults).headers = { 'x-api-key': apiKey };

    fetchMocker.enableMocks();
    fetchMocker.resetMocks();
  });

  it('returns new assets when upload file is successful', async () => {
    fetchMocker.doMockIf(new RegExp(`${baseUrl}/assets$`), function () {
      return {
        status: 200,
        body: JSON.stringify({ id: 'fc5621b1-86f6-44a1-9905-403e607df9f5', status: 'created' }),
      };
    });

    await expect(uploadFiles([testFilePath], { concurrency: 1 })).resolves.toEqual([
      {
        filepath: testFilePath,
        id: 'fc5621b1-86f6-44a1-9905-403e607df9f5',
      },
    ]);
  });

  it('returns new assets when upload file retry is successful', async () => {
    let counter = 0;
    fetchMocker.doMockIf(new RegExp(`${baseUrl}/assets$`), function () {
      counter++;
      if (counter < retry) {
        throw new Error('Network error');
      }

      return {
        status: 200,
        body: JSON.stringify({ id: 'fc5621b1-86f6-44a1-9905-403e607df9f5', status: 'created' }),
      };
    });

    await expect(uploadFiles([testFilePath], { concurrency: 1 })).resolves.toEqual([
      {
        filepath: testFilePath,
        id: 'fc5621b1-86f6-44a1-9905-403e607df9f5',
      },
    ]);
  });

  it('returns new assets when upload file retry is failed', async () => {
    fetchMocker.doMockIf(new RegExp(`${baseUrl}/assets$`), function () {
      throw new Error('Network error');
    });

    await expect(uploadFiles([testFilePath], { concurrency: 1 })).resolves.toEqual([]);
  });

  it('uploads nothing when upload is disabled', async () => {
    await expect(uploadFiles([testFilePath], { concurrency: 1, upload: false })).resolves.toEqual([]);

    expect(fetchMocker.mock.calls.length).toBe(0);
  });

  it('uploads assets with the specified visibility', async () => {
    fetchMocker.doMockIf(new RegExp(`${baseUrl}/assets$`), function () {
      return {
        status: 200,
        body: JSON.stringify({ id: 'fc5621b1-86f6-44a1-9905-403e607df9f5', status: 'created' }),
      };
    });

    await uploadFiles([testFilePath], { concurrency: 1, visibility: AssetVisibility.Hidden });

    const formData = fetchMocker.mock.calls[0]?.[1]?.body as FormData;
    expect(formData.get('visibility')).toBe('hidden');
  });
});

describe('checkForDuplicates', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
  const testFilePath = path.join(testDir, 'test.png');
  const testFileData = 'test';
  const testFileChecksum = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3'; // SHA1
  const retry = 3;

  beforeEach(() => {
    // Create a test file
    fs.writeFileSync(testFilePath, testFileData);
  });

  it('checks duplicates', async () => {
    vi.mocked(checkBulkUpload).mockResolvedValue({
      results: [
        {
          action: AssetUploadAction.Accept,
          id: testFilePath,
        },
      ],
    });

    await checkForDuplicates([testFilePath], { concurrency: 1 });

    expect(checkBulkUpload).toHaveBeenCalledWith({
      assetBulkUploadCheckDto: {
        assets: [
          {
            checksum: testFileChecksum,
            id: testFilePath,
          },
        ],
      },
    });
  });

  it('returns duplicates when check duplicates is rejected', async () => {
    vi.mocked(checkBulkUpload).mockResolvedValue({
      results: [
        {
          action: AssetUploadAction.Reject,
          id: testFilePath,
          assetId: 'fc5621b1-86f6-44a1-9905-403e607df9f5',
          reason: AssetRejectReason.Duplicate,
        },
      ],
    });

    await expect(checkForDuplicates([testFilePath], { concurrency: 1 })).resolves.toEqual({
      duplicates: [
        {
          filepath: testFilePath,
          id: 'fc5621b1-86f6-44a1-9905-403e607df9f5',
          checksum: testFileChecksum,
          fromCache: false,
        },
      ],
      newFiles: [],
      rejects: [],
    });
  });

  it('does not treat an unsupported format rejection as a duplicate', async () => {
    vi.mocked(checkBulkUpload).mockResolvedValue({
      results: [
        {
          action: AssetUploadAction.Reject,
          id: testFilePath,
          reason: AssetRejectReason.UnsupportedFormat,
        },
      ],
    });

    await expect(checkForDuplicates([testFilePath], { concurrency: 1 })).resolves.toEqual({
      duplicates: [],
      newFiles: [],
      rejects: [{ filepath: testFilePath, reason: AssetRejectReason.UnsupportedFormat }],
    });
  });

  it('does not treat a duplicate rejection without an asset id as a duplicate', async () => {
    vi.mocked(checkBulkUpload).mockResolvedValue({
      results: [
        {
          action: AssetUploadAction.Reject,
          id: testFilePath,
          reason: AssetRejectReason.Duplicate,
        },
      ],
    });

    await expect(checkForDuplicates([testFilePath], { concurrency: 1 })).resolves.toEqual({
      duplicates: [],
      newFiles: [],
      rejects: [{ filepath: testFilePath, reason: AssetRejectReason.Duplicate }],
    });
  });

  it('does not treat an unrecognised rejection reason as a duplicate', async () => {
    vi.mocked(checkBulkUpload).mockResolvedValue({
      results: [
        {
          action: AssetUploadAction.Reject,
          id: testFilePath,
          assetId: 'fc5621b1-86f6-44a1-9905-403e607df9f5',
          reason: 'some-future-reason' as AssetRejectReason,
        },
      ],
    });

    await expect(checkForDuplicates([testFilePath], { concurrency: 1 })).resolves.toEqual({
      duplicates: [],
      newFiles: [],
      rejects: [{ filepath: testFilePath, reason: 'some-future-reason' }],
    });
  });

  it('returns new assets when check duplicates is accepted', async () => {
    vi.mocked(checkBulkUpload).mockResolvedValue({
      results: [
        {
          action: AssetUploadAction.Accept,
          id: testFilePath,
        },
      ],
    });

    await expect(checkForDuplicates([testFilePath], { concurrency: 1 })).resolves.toEqual({
      duplicates: [],
      newFiles: [testFilePath],
      rejects: [],
    });
  });

  it('returns results when check duplicates retry is successful', async () => {
    let mocked = vi.mocked(checkBulkUpload);
    for (let i = 1; i < retry; i++) {
      mocked = mocked.mockRejectedValueOnce(new Error('Network error'));
    }
    mocked.mockResolvedValue({
      results: [
        {
          action: AssetUploadAction.Accept,
          id: testFilePath,
        },
      ],
    });

    await expect(checkForDuplicates([testFilePath], { concurrency: 1 })).resolves.toEqual({
      duplicates: [],
      newFiles: [testFilePath],
      rejects: [],
    });
  });

  it('returns results when check duplicates retry is failed', async () => {
    vi.mocked(checkBulkUpload).mockRejectedValue(new Error('Network error'));

    await expect(checkForDuplicates([testFilePath], { concurrency: 1 })).resolves.toEqual({
      duplicates: [],
      newFiles: [],
      rejects: [],
    });
  });
});

describe('upload', () => {
  const baseUrl = 'https://example.com';
  const fetchMocker = createFetchMock(vi);

  let testDir: string;
  let newFilePath: string;
  let duplicateFilePath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-no-upload-'));
    newFilePath = path.join(testDir, 'new.jpg');
    duplicateFilePath = path.join(testDir, 'duplicate.jpg');
    fs.writeFileSync(newFilePath, 'new');
    fs.writeFileSync(duplicateFilePath, 'duplicate');

    vi.mocked(defaults).baseUrl = baseUrl;
    vi.mocked(defaults).headers = { 'x-api-key': 'key' };
    vi.mocked(getSupportedMediaTypes).mockResolvedValue({
      image: ['.jpg'],
      sidecar: ['.xmp'],
      video: ['.mp4'],
    });

    fetchMocker.enableMocks();
    fetchMocker.resetMocks();
    fetchMocker.doMockIf(new RegExp(`${baseUrl}/assets$`), function () {
      return {
        status: 201,
        body: JSON.stringify({ id: 'fc5621b1-86f6-44a1-9905-403e607df9f5', status: 'created' }),
      };
    });

    vi.mocked(checkBulkUpload).mockResolvedValue({
      results: [
        {
          action: AssetUploadAction.Accept,
          id: newFilePath,
        },
        {
          action: AssetUploadAction.Reject,
          id: duplicateFilePath,
          assetId: '8b7f1a2c-0d3e-4f5a-9b6c-7d8e9f0a1b2c',
          reason: AssetRejectReason.Duplicate,
        },
      ],
    });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('uploads new files by default', async () => {
    await upload([testDir], {} as BaseOptions, { concurrency: 1 });

    expect(fetchMocker.mock.calls.length).toBe(1);
    expect(fs.existsSync(newFilePath)).toBe(true);
  });

  it('uploads nothing when upload is disabled, but still deletes duplicates', async () => {
    await upload([testDir], {} as BaseOptions, { concurrency: 1, upload: false, deleteDuplicates: true });

    expect(fetchMocker.mock.calls.length).toBe(0);
    expect(fs.existsSync(duplicateFilePath)).toBe(false);
    expect(fs.existsSync(newFilePath)).toBe(true);
  });

  it('deletes nothing when upload is disabled alongside a dry run', async () => {
    await upload([testDir], {} as BaseOptions, {
      concurrency: 1,
      upload: false,
      deleteDuplicates: true,
      dryRun: true,
    });

    expect(fetchMocker.mock.calls.length).toBe(0);
    expect(fs.existsSync(duplicateFilePath)).toBe(true);
    expect(fs.existsSync(newFilePath)).toBe(true);
  });
});

describe('startWatch', () => {
  let testFolder: string;
  let checkBulkUploadMocked: MockedFunction<typeof checkBulkUpload>;

  beforeEach(async () => {
    vi.restoreAllMocks();

    vi.mocked(getSupportedMediaTypes).mockResolvedValue({
      image: ['.jpg'],
      sidecar: ['.xmp'],
      video: ['.mp4'],
    });

    testFolder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'test-startWatch-'));
    checkBulkUploadMocked = vi.mocked(checkBulkUpload);
    checkBulkUploadMocked.mockResolvedValue({
      results: [],
    });
  });

  it('should start watching a directory and upload new files', async () => {
    const testFilePath = path.join(testFolder, 'test.jpg');

    await startWatch([testFolder], { concurrency: 1 }, { batchSize: 1, debounceTimeMs: 10 });
    await sleep(100); // to debounce the watcher from considering the test file as a existing file
    await fs.promises.writeFile(testFilePath, 'testjpg');

    await vi.waitFor(
      () =>
        expect(checkBulkUpload).toHaveBeenCalledWith({
          assetBulkUploadCheckDto: {
            assets: [
              expect.objectContaining({
                id: testFilePath,
              }),
            ],
          },
        }),
      { timeout: 5000 },
    );
  });

  it('should filter out unsupported files', async () => {
    const testFilePath = path.join(testFolder, 'test.jpg');
    const unsupportedFilePath = path.join(testFolder, 'test.txt');

    await startWatch([testFolder], { concurrency: 1 }, { batchSize: 1, debounceTimeMs: 10 });
    await sleep(100); // to debounce the watcher from considering the test file as a existing file
    await fs.promises.writeFile(testFilePath, 'testjpg');
    await fs.promises.writeFile(unsupportedFilePath, 'testtxt');

    await vi.waitFor(
      () =>
        expect(checkBulkUpload).toHaveBeenCalledWith({
          assetBulkUploadCheckDto: {
            assets: expect.arrayContaining([
              expect.objectContaining({
                id: testFilePath,
              }),
            ]),
          },
        }),
      { timeout: 5000 },
    );

    expect(checkBulkUpload).not.toHaveBeenCalledWith({
      assetBulkUploadCheckDto: {
        assets: expect.arrayContaining([
          expect.objectContaining({
            id: unsupportedFilePath,
          }),
        ]),
      },
    });
  });

  it('should filter out ignored patterns', async () => {
    const testFilePath = path.join(testFolder, 'test.jpg');
    const ignoredPattern = 'ignored';
    const ignoredFolder = path.join(testFolder, ignoredPattern);
    await fs.promises.mkdir(ignoredFolder, { recursive: true });
    const ignoredFilePath = path.join(ignoredFolder, 'ignored.jpg');

    await startWatch([testFolder], { concurrency: 1, ignore: ignoredPattern }, { batchSize: 1, debounceTimeMs: 10 });
    await sleep(100); // to debounce the watcher from considering the test file as a existing file
    await fs.promises.writeFile(testFilePath, 'testjpg');
    await fs.promises.writeFile(ignoredFilePath, 'ignoredjpg');

    await vi.waitFor(
      () =>
        expect(checkBulkUpload).toHaveBeenCalledWith({
          assetBulkUploadCheckDto: {
            assets: expect.arrayContaining([
              expect.objectContaining({
                id: testFilePath,
              }),
            ]),
          },
        }),
      { timeout: 5000 },
    );

    expect(checkBulkUpload).not.toHaveBeenCalledWith({
      assetBulkUploadCheckDto: {
        assets: expect.arrayContaining([
          expect.objectContaining({
            id: ignoredFilePath,
          }),
        ]),
      },
    });
  });

  afterEach(async () => {
    await fs.promises.rm(testFolder, { recursive: true, force: true });
  });
});

describe('findSidecar', () => {
  let testDir: string;
  let testFilePath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-sidecar-'));
    testFilePath = path.join(testDir, 'test.jpg');
    fs.writeFileSync(testFilePath, 'test');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should find sidecar file with photo.xmp naming convention', () => {
    const sidecarPath = path.join(testDir, 'test.xmp');
    fs.writeFileSync(sidecarPath, 'xmp data');

    const result = findSidecar(testFilePath);
    expect(result).toBe(sidecarPath);
  });

  it('should find sidecar file with photo.ext.xmp naming convention', () => {
    const sidecarPath = path.join(testDir, 'test.jpg.xmp');
    fs.writeFileSync(sidecarPath, 'xmp data');

    const result = findSidecar(testFilePath);
    expect(result).toBe(sidecarPath);
  });

  it('should prefer photo.ext.xmp over photo.xmp when both exist', () => {
    const sidecarPath1 = path.join(testDir, 'test.xmp');
    const sidecarPath2 = path.join(testDir, 'test.jpg.xmp');
    fs.writeFileSync(sidecarPath1, 'xmp data 1');
    fs.writeFileSync(sidecarPath2, 'xmp data 2');

    const result = findSidecar(testFilePath);
    // Should return the first one found (photo.xmp) based on the order in the code
    expect(result).toBe(sidecarPath1);
  });

  it('should return undefined when no sidecar file exists', () => {
    const result = findSidecar(testFilePath);
    expect(result).toBeUndefined();
  });
});

describe('deleteFiles', () => {
  let testDir: string;
  let testFilePath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-delete-'));
    testFilePath = path.join(testDir, 'test.jpg');
    fs.writeFileSync(testFilePath, 'test');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should delete asset and sidecar file when main file is deleted', async () => {
    const sidecarPath = path.join(testDir, 'test.xmp');
    fs.writeFileSync(sidecarPath, 'xmp data');

    await deleteFiles([{ id: 'test-id', filepath: testFilePath }], [], { delete: true, concurrency: 1 });

    expect(fs.existsSync(testFilePath)).toBe(false);
    expect(fs.existsSync(sidecarPath)).toBe(false);
  });

  it('should delete a confirmed duplicate but keep a file rejected as an unsupported format', async () => {
    const duplicatePath = path.join(testDir, 'duplicate.jpg');
    fs.writeFileSync(duplicatePath, 'duplicate');

    vi.mocked(checkBulkUpload).mockResolvedValue({
      results: [
        {
          action: AssetUploadAction.Reject,
          id: duplicatePath,
          assetId: 'fc5621b1-86f6-44a1-9905-403e607df9f5',
          reason: AssetRejectReason.Duplicate,
        },
        {
          action: AssetUploadAction.Reject,
          id: testFilePath,
          reason: AssetRejectReason.UnsupportedFormat,
        },
      ],
    });

    const { duplicates } = await checkForDuplicates([duplicatePath, testFilePath], { concurrency: 1 });
    await deleteFiles([], duplicates, { deleteDuplicates: true, concurrency: 1 });

    expect(fs.existsSync(duplicatePath)).toBe(false);
    expect(fs.existsSync(testFilePath)).toBe(true);
  });

  it('should not delete sidecar file when delete option is false', async () => {
    const sidecarPath = path.join(testDir, 'test.xmp');
    fs.writeFileSync(sidecarPath, 'xmp data');

    await deleteFiles([{ id: 'test-id', filepath: testFilePath }], [], { delete: false, concurrency: 1 });

    expect(fs.existsSync(testFilePath)).toBe(true);
    expect(fs.existsSync(sidecarPath)).toBe(true);
  });
});

describe('pipelined upload', () => {
  const baseUrl = 'https://example.com';
  const fetchMocker = createFetchMock(vi);

  let testDir: string;
  let files: string[];
  let logSpy: MockInstance<typeof console.log>;

  const makeFiles = (count: number) =>
    Array.from({ length: count }, (_, index) => {
      const filepath = path.join(testDir, `file-${index}.jpg`);
      fs.writeFileSync(filepath, `contents ${index}`);
      return filepath;
    });

  const batchSizes = () =>
    vi.mocked(checkBulkUpload).mock.calls.map((call) => call[0].assetBulkUploadCheckDto.assets.length);

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-pipeline-'));
    files = makeFiles(10);

    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    vi.mocked(defaults).baseUrl = baseUrl;
    vi.mocked(defaults).headers = { 'x-api-key': 'key' };
    vi.mocked(getSupportedMediaTypes).mockResolvedValue({ image: ['.jpg'], sidecar: ['.xmp'], video: ['.mp4'] });

    // Accept everything the server is asked about. Reset first: the module mock is shared with
    // every other suite in this file, so its call history would otherwise still be there.
    vi.mocked(checkBulkUpload).mockReset();
    vi.mocked(checkBulkUpload).mockImplementation(async ({ assetBulkUploadCheckDto }) => ({
      results: assetBulkUploadCheckDto.assets.map(({ id }) => ({ action: AssetUploadAction.Accept, id })),
    }));

    fetchMocker.enableMocks();
    fetchMocker.resetMocks();
    fetchMocker.doMockIf(new RegExp(`${baseUrl}/assets$`), () => ({
      status: 201,
      body: JSON.stringify({ id: 'fc5621b1-86f6-44a1-9905-403e607df9f5', status: 'created' }),
    }));
  });

  afterEach(() => {
    logSpy.mockRestore();
    fetchMocker.disableMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('bulk-upload-check batching policy', () => {
    it('sends full batches under a fast producer, and only the tail is short', async () => {
      await checkForDuplicates(files, { concurrency: 4 }, { batchSize: 4, idleMs: 1000, onAccepted: async () => {} });

      // 10 files, batches of 4: two full requests plus the tail. The idle timer never fires,
      // because the producer never leaves the batcher idle for a whole second.
      expect(batchSizes()).toEqual([4, 4, 2]);
    });

    it('does not arm the idle flush when nobody is consuming the results', async () => {
      await checkForDuplicates(files, { concurrency: 4 });

      // Unchanged from the pre-pipeline behaviour: one request for everything under 5,000 files.
      expect(batchSizes()).toEqual([10]);
    });

    it('flushes a partial batch when the producer goes idle', async () => {
      // 60 ms per file against a 20 ms idle window, so every file is its own batch. This is the
      // case the size-only policy handled worst: large files would otherwise leave the network
      // idle until 5,000 of them had been hashed.
      await checkForDuplicates(
        files.slice(0, 4),
        { concurrency: 1 },
        { batchSize: 5000, idleMs: 20, onAccepted: async () => {}, onBeforeHash: () => sleep(60) },
      );

      expect(batchSizes()).toEqual([1, 1, 1, 1]);
    });

    it('issues a single check request for a small directory', async () => {
      await upload([testDir], {} as BaseOptions, { concurrency: 4 });

      expect(batchSizes()).toEqual([10]);
      expect(fetchMocker.mock.calls.length).toBe(10);
    });
  });

  describe('overlap', () => {
    it('uploads accepted files while later files are still being hashed', async () => {
      const events: string[] = [];
      const uploader = new Uploader({ concurrency: 1 });

      fetchMocker.doMockIf(new RegExp(`${baseUrl}/assets$`), () => {
        events.push('upload');
        return { status: 201, body: JSON.stringify({ id: 'asset-id', status: 'created' }) };
      });

      await checkForDuplicates(
        files,
        { concurrency: 1 },
        {
          batchSize: 2,
          idleMs: 1000,
          onAccepted: (filepaths) => uploader.add(filepaths),
          onBeforeHash: async () => {
            events.push('hash');
            await uploader.waitForCapacity();
          },
        },
      );
      await uploader.drain();

      expect(events.filter((event) => event === 'upload')).toHaveLength(10);
      // The point of the change: an upload went out before the last file was read off disk.
      expect(events.indexOf('upload')).toBeLessThan(events.lastIndexOf('hash'));
    });
  });

  describe('backpressure', () => {
    it('stops handing over files once the upload queue is saturated', async () => {
      const { promise: gate, resolve: release } = Promise.withResolvers<void>();

      fetchMocker.doMockIf(new RegExp(`${baseUrl}/assets$`), async () => {
        await gate;
        return { status: 201, body: JSON.stringify({ id: 'asset-id', status: 'created' }) };
      });

      const uploader = new Uploader({ concurrency: 1 });
      const added = uploader.add(makeFiles(40));

      // concurrency 1 x UPLOAD_BACKLOG_FACTOR 4. Without a bound all 40 would be queued at once.
      await vi.waitFor(() => expect(uploader.pendingCount).toBe(4));
      await sleep(50);
      expect(uploader.pendingCount).toBe(4);
      expect(uploader.saturated).toBe(true);

      release();
      await added;
      await uploader.drain();

      expect(uploader.pendingCount).toBe(0);
      expect(uploader.report()).toHaveLength(40);
    });

    it('wakes every waiter when a slot frees, so the hand-off is not starved behind hashing', async () => {
      // Hashing and the hand-off both park on waitForCapacity, and hashing does not consume a slot
      // when it wakes. Waking one waiter per freed slot let the hashers take every wakeup in turn
      // and left the upload queue idle with room to spare.
      let isOpen = false;
      const held: Array<() => void> = [];

      fetchMocker.doMockIf(new RegExp(`${baseUrl}/assets$`), async () => {
        if (!isOpen) {
          const { promise, resolve } = Promise.withResolvers<void>();
          held.push(resolve);
          await promise;
        }
        return { status: 201, body: JSON.stringify({ id: 'asset-id', status: 'created' }) };
      });

      const uploader = new Uploader({ concurrency: 2 });
      const added = uploader.add(makeFiles(30));

      // concurrency 2 x UPLOAD_BACKLOG_FACTOR 4.
      await vi.waitFor(() => expect(uploader.pendingCount).toBe(8));

      // Stand in for the hashing workers parked on the same gate.
      let woken = 0;
      for (let index = 0; index < 4; index++) {
        void uploader.waitForCapacity().then(() => {
          woken += 1;
        });
      }
      await sleep(20);
      expect(woken).toBe(0);

      // Exactly one upload completes.
      await vi.waitFor(() => expect(held.length).toBeGreaterThan(0));
      held.shift()?.();

      await vi.waitFor(() => expect(woken).toBe(4));
      // ...and the hand-off, not just the hashers, got the freed slot back.
      await vi.waitFor(() => expect(uploader.pendingCount).toBe(8));

      isOpen = true;
      const stillHeld = [...held];
      held.length = 0;
      for (const resolve of stillHeld) {
        resolve();
      }
      await added;
      await uploader.drain();

      expect(uploader.report()).toHaveLength(30);
    });

    it('holds hashing back while the consumer is saturated', async () => {
      const { promise: gate, resolve: release } = Promise.withResolvers<void>();

      const checking = checkForDuplicates(files, { concurrency: 4 }, { batchSize: 1, onBeforeHash: () => gate });

      await sleep(50);
      expect(checkBulkUpload).not.toHaveBeenCalled();

      release();
      const { newFiles, duplicates, rejects } = await checking;
      expect(newFiles.toSorted()).toEqual(files.toSorted());
      expect({ duplicates, rejects }).toEqual({ duplicates: [], rejects: [] });
    });
  });

  describe('failures and final phases', () => {
    it('does not report a file whose upload exhausted its retries as uploaded', async () => {
      // Concurrency 1, so the first three attempts are the three retries of the first file.
      let attempts = 0;
      fetchMocker.doMockIf(new RegExp(`${baseUrl}/assets$`), () => {
        attempts += 1;
        if (attempts <= 3) {
          throw new Error('Network error');
        }
        return { status: 201, body: JSON.stringify({ id: 'asset-id', status: 'created' }) };
      });

      await upload([testDir], {} as BaseOptions, { concurrency: 1, delete: true });

      // The server never took it, so --delete must leave the only copy alone.
      expect(fs.existsSync(files[0])).toBe(true);
      for (const filepath of files.slice(1)) {
        expect(fs.existsSync(filepath)).toBe(false);
      }
    });

    it('deletes nothing until every upload has finished', async () => {
      fetchMocker.doMockIf(new RegExp(`${baseUrl}/assets$`), () => {
        // Deletion stays a final phase: nothing may be unlinked while uploads are in flight.
        expect(files.filter((filepath) => fs.existsSync(filepath))).toHaveLength(files.length);
        return { status: 201, body: JSON.stringify({ id: 'asset-id', status: 'created' }) };
      });

      await upload([testDir], {} as BaseOptions, { concurrency: 2, delete: true });

      expect(files.filter((filepath) => fs.existsSync(filepath))).toHaveLength(0);
    });

    it('surfaces a mid-pipeline error without leaving a queue undrained', async () => {
      vi.mocked(checkBulkUpload).mockImplementation(async () => {
        throw new Error('server exploded');
      });

      await expect(upload([testDir], {} as BaseOptions, { concurrency: 2 })).resolves.toBeUndefined();

      // Every check retry failed, so nothing was accepted and nothing was uploaded.
      expect(fetchMocker.mock.calls.length).toBe(0);
      for (const filepath of files) {
        expect(fs.existsSync(filepath)).toBe(true);
      }
    });
  });

  describe('options that must not regress', () => {
    it('leaves new files in place with --no-upload', async () => {
      await upload([testDir], {} as BaseOptions, { concurrency: 2, upload: false });

      expect(fetchMocker.mock.calls.length).toBe(0);
      for (const filepath of files) {
        expect(fs.existsSync(filepath)).toBe(true);
      }
      expect(logSpy.mock.calls.flat().join('\n')).toContain('Not uploading 10 new assets');
    });

    it('uploads nothing with --dry-run', async () => {
      await upload([testDir], {} as BaseOptions, { concurrency: 2, dryRun: true, delete: true });

      expect(fetchMocker.mock.calls.length).toBe(0);
      for (const filepath of files) {
        expect(fs.existsSync(filepath)).toBe(true);
      }
      expect(logSpy.mock.calls.flat().join('\n')).toContain('Would have uploaded 10 assets');
    });

    it('emits the full json output shape', async () => {
      await upload([testDir], {} as BaseOptions, { concurrency: 2, jsonOutput: true });

      const payload = logSpy.mock.calls.map((call) => String(call[0])).find((line) => line.trimStart().startsWith('{'));
      expect(payload).toBeDefined();

      const parsed = JSON.parse(payload as string);
      expect(Object.keys(parsed).toSorted()).toEqual(['duplicates', 'newAssets', 'newFiles', 'rejects']);
      expect(parsed.newFiles).toHaveLength(10);
      expect(parsed.newAssets).toHaveLength(10);
    });
  });
});

describe('hash cache integration', () => {
  // A whole number of seconds, so that mtime_ns can be restored exactly — the `touch -r` case that
  // makes a stale cache hit possible in the first place.
  const fixedTime = 1_700_000_000;
  const assetId = 'fc5621b1-86f6-44a1-9905-403e607df9f5';

  let testDir: string;
  let duplicatePath: string;
  let logSpy: MockInstance<typeof console.log>;

  const logged = () => logSpy.mock.calls.map((call) => call.join(' ')).join('\n');

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'immich-cache-test-'));
    duplicatePath = path.join(testDir, 'duplicate.jpg');
    fs.writeFileSync(duplicatePath, 'duplicate');
    fs.utimesSync(duplicatePath, fixedTime, fixedTime);

    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    vi.mocked(checkBulkUpload).mockResolvedValue({
      results: [{ action: AssetUploadAction.Reject, id: duplicatePath, assetId, reason: AssetRejectReason.Duplicate }],
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('hashes on the first run and reuses the checksum on the next', async () => {
    const first = await checkForDuplicates([duplicatePath], { concurrency: 1 });
    expect(first.duplicates[0].fromCache).toBe(false);
    expect(logged()).toContain('Hash cache: 0/1 file reused');

    // Close and reopen so the second run genuinely reads the checksum back off disk.
    closeHashCache();
    logSpy.mockClear();

    const second = await checkForDuplicates([duplicatePath], { concurrency: 1 });
    expect(second.duplicates[0].fromCache).toBe(true);
    expect(second.duplicates[0].checksum).toBe(first.duplicates[0].checksum);
    expect(logged()).toContain('Hash cache: 1/1 file reused');
  });

  it('deletes a cached duplicate whose contents really are unchanged', async () => {
    await checkForDuplicates([duplicatePath], { concurrency: 1 });
    closeHashCache();

    const { duplicates } = await checkForDuplicates([duplicatePath], { concurrency: 1 });
    expect(duplicates[0].fromCache).toBe(true);

    await deleteFiles([], duplicates, { deleteDuplicates: true, concurrency: 1 });

    expect(fs.existsSync(duplicatePath)).toBe(false);
  });

  it('refuses to delete a duplicate whose cached checksum has gone stale', async () => {
    await checkForDuplicates([duplicatePath], { concurrency: 1 });
    closeHashCache();

    // The hazard in full: the contents change, but size, inode and nanosecond mtime are all put
    // back, exactly as `touch -r`, `rsync --times` or a restore tool would leave them.
    const before = fs.statSync(duplicatePath, { bigint: true });
    fs.writeFileSync(duplicatePath, 'DUPLICATE');
    fs.utimesSync(duplicatePath, fixedTime, fixedTime);
    const after = fs.statSync(duplicatePath, { bigint: true });
    expect(after.size).toBe(before.size);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).toBe(before.mtimeNs);

    const { duplicates } = await checkForDuplicates([duplicatePath], { concurrency: 1 });
    expect(duplicates[0].fromCache).toBe(true);

    await deleteFiles([], duplicates, { deleteDuplicates: true, concurrency: 1 });

    expect(fs.existsSync(duplicatePath)).toBe(true);
    expect(fs.readFileSync(duplicatePath, 'utf8')).toBe('DUPLICATE');
    expect(logged()).toContain('WARNING: the hash cache was stale for 1 file, which will NOT be deleted');
    expect(logged()).toContain(duplicatePath);
  });

  it('records the corrected checksum so the next run is not stale twice', async () => {
    await checkForDuplicates([duplicatePath], { concurrency: 1 });
    closeHashCache();

    fs.writeFileSync(duplicatePath, 'DUPLICATE');
    fs.utimesSync(duplicatePath, fixedTime, fixedTime);

    const stale = await checkForDuplicates([duplicatePath], { concurrency: 1 });
    await deleteFiles([], stale.duplicates, { deleteDuplicates: true, concurrency: 1 });
    closeHashCache();

    const corrected = await checkForDuplicates([duplicatePath], { concurrency: 1 });
    expect(corrected.duplicates[0].fromCache).toBe(true);
    expect(corrected.duplicates[0].checksum).not.toBe(stale.duplicates[0].checksum);

    await deleteFiles([], corrected.duplicates, { deleteDuplicates: true, concurrency: 1 });
    expect(fs.existsSync(duplicatePath)).toBe(false);
  });

  it('bypasses the cache entirely with --no-cache', async () => {
    const first = await checkForDuplicates([duplicatePath], { concurrency: 1, cache: false });
    closeHashCache();
    const second = await checkForDuplicates([duplicatePath], { concurrency: 1, cache: false });

    expect(first.duplicates[0].fromCache).toBe(false);
    expect(second.duplicates[0].fromCache).toBe(false);
    expect(fs.existsSync(cacheFilePath())).toBe(false);
    expect(logged()).not.toContain('Hash cache:');
  });

  it('does not re-hash before deleting when nothing will be deleted', async () => {
    await checkForDuplicates([duplicatePath], { concurrency: 1 });
    closeHashCache();

    const { duplicates } = await checkForDuplicates([duplicatePath], { concurrency: 1 });
    fs.rmSync(duplicatePath);

    // A missing file would be reported by the guard; without --delete-duplicates it never runs.
    await deleteFiles([], duplicates, { concurrency: 1 });

    expect(logged()).not.toContain('WARNING');
  });
});
