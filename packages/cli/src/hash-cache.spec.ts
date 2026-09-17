import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HashCache, clearHashCache, getCacheDirectory } from 'src/hash-cache';

const CHECKSUM_A = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3';
const CHECKSUM_B = 'b1946ac92492d2347c6235b4d2611184e2b5f9b0';

// A whole number of seconds so that mtimeNs round-trips through utimesSync exactly, which the
// tests below assert rather than assume.
const FIXED_TIME_SECONDS = 1_700_000_000;

const setMtime = (filepath: string, seconds = FIXED_TIME_SECONDS) => fs.utimesSync(filepath, seconds, seconds);
const statOf = (filepath: string) => fs.statSync(filepath, { bigint: true });

describe('hash cache', () => {
  let cacheDirectory: string;
  let workDirectory: string;
  let filepath: string;

  beforeEach(() => {
    cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'immich-cache-'));
    workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'immich-files-'));
    filepath = path.join(workDirectory, 'photo.jpg');
    fs.writeFileSync(filepath, 'test');
    setMtime(filepath);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(cacheDirectory, { recursive: true, force: true });
    fs.rmSync(workDirectory, { recursive: true, force: true });
  });

  describe('getCacheDirectory', () => {
    it('uses XDG_CACHE_HOME when it is set', () => {
      vi.stubEnv('XDG_CACHE_HOME', '/xdg');
      expect(getCacheDirectory()).toBe(path.join('/xdg', 'immich'));
    });

    it('falls back to ~/.cache and never to the config directory', () => {
      vi.stubEnv('XDG_CACHE_HOME', '');
      expect(getCacheDirectory()).toBe(path.join(os.homedir(), '.cache', 'immich'));
    });
  });

  it('returns a cached checksum for an unchanged file', () => {
    const cache = new HashCache(cacheDirectory);
    cache.set(statOf(filepath), CHECKSUM_A);
    cache.close();

    const reopened = new HashCache(cacheDirectory);
    expect(reopened.get(statOf(filepath))).toBe(CHECKSUM_A);
    expect(reopened.hits).toBe(1);
    expect(reopened.misses).toBe(0);
    reopened.close();
  });

  it('misses when the size changes', () => {
    const cache = new HashCache(cacheDirectory);
    cache.set(statOf(filepath), CHECKSUM_A);

    fs.writeFileSync(filepath, 'test-but-longer');
    setMtime(filepath);

    expect(cache.get(statOf(filepath))).toBeUndefined();
    expect(cache.misses).toBe(1);
    cache.close();
  });

  it('misses when mtime_ns changes but the size does not', () => {
    const cache = new HashCache(cacheDirectory);
    const before = statOf(filepath);
    cache.set(before, CHECKSUM_A);

    fs.writeFileSync(filepath, 'best');
    setMtime(filepath, FIXED_TIME_SECONDS + 1);
    const after = statOf(filepath);

    expect(after.size).toBe(before.size);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).not.toBe(before.mtimeNs);
    expect(cache.get(after)).toBeUndefined();
    cache.close();
  });

  it('misses when the inode changes with the same size and mtime_ns', () => {
    const cache = new HashCache(cacheDirectory);
    const original = statOf(filepath);
    cache.set(original, CHECKSUM_A);

    // A replacement at the same path: same length, same timestamp, different inode. Keying on the
    // path alone would hand back the old checksum here.
    const replacement = path.join(workDirectory, 'replacement.jpg');
    fs.writeFileSync(replacement, 'best');
    setMtime(replacement);
    fs.renameSync(replacement, filepath);
    const replaced = statOf(filepath);

    expect(replaced.size).toBe(original.size);
    expect(replaced.mtimeNs).toBe(original.mtimeNs);
    expect(replaced.ino).not.toBe(original.ino);
    expect(cache.get(replaced)).toBeUndefined();
    cache.close();
  });

  it('keys on file identity rather than path, so a moved file still hits', () => {
    const cache = new HashCache(cacheDirectory);
    cache.set(statOf(filepath), CHECKSUM_A);

    const moved = path.join(workDirectory, 'moved.jpg');
    fs.renameSync(filepath, moved);

    expect(cache.get(statOf(moved))).toBe(CHECKSUM_A);
    cache.close();
  });

  it('keeps what an interrupted run hashed', () => {
    // Never closed and never flushed explicitly: this is a run that was killed part-way through.
    const interrupted = new HashCache(cacheDirectory);
    for (let index = 0; index < 100; index++) {
      const scratch = path.join(workDirectory, `file-${index}.jpg`);
      fs.writeFileSync(scratch, `contents ${index}`);
      interrupted.set(statOf(scratch), CHECKSUM_A);
    }
    interrupted.set(statOf(filepath), CHECKSUM_B);

    // Nothing has been closed and no run has finished, yet the log already holds most of the work.
    const midRun = new HashCache(cacheDirectory);
    expect(midRun.size).toBeGreaterThan(0);
    midRun.close();

    // The exit handler is what a process killed by SIGINT would run; call it directly.
    interrupted.flush();

    const resumed = new HashCache(cacheDirectory);
    expect(resumed.get(statOf(filepath))).toBe(CHECKSUM_B);
    expect(resumed.size).toBe(101);
    resumed.close();
  });

  it('drops a torn or interleaved line instead of trusting it', () => {
    const cache = new HashCache(cacheDirectory);
    cache.set(statOf(filepath), CHECKSUM_A);
    cache.close();

    const logPath = path.join(cacheDirectory, 'hash-cache.jsonl');
    const stats = statOf(filepath);
    fs.appendFileSync(
      logPath,
      `{"d":"${stats.dev}","i":"${stats.ino}","s":"${stats.size}","m":"${stats.mtimeNs}","c":"deadbee\n` +
        `{"d":"1","i":"2","s":"3","m":"4","c":"not-a-checksum","t":1}\n`,
    );

    const reopened = new HashCache(cacheDirectory);
    expect(reopened.get(stats)).toBe(CHECKSUM_A);
    expect(reopened.size).toBe(1);
    reopened.close();
  });

  it('ages out entries that have not been used for a month', () => {
    const cache = new HashCache(cacheDirectory);
    cache.set(statOf(filepath), CHECKSUM_A);
    cache.close();

    const lastUsed = Math.floor(Date.now() / 1000) - 40 * 24 * 60 * 60;
    const logPath = path.join(cacheDirectory, 'hash-cache.jsonl');
    const aged = fs
      .readFileSync(logPath, 'utf8')
      .trim()
      .replace(/"t":\d+/, () => `"t":${lastUsed}`);
    fs.writeFileSync(logPath, aged + '\n');

    const reopened = new HashCache(cacheDirectory);
    expect(reopened.size).toBe(0);
    expect(reopened.get(statOf(filepath))).toBeUndefined();
    reopened.close();
  });

  it('survives a cache file it cannot parse at all', () => {
    fs.mkdirSync(cacheDirectory, { recursive: true });
    fs.writeFileSync(path.join(cacheDirectory, 'hash-cache.jsonl'), 'not json\n\0\n{]\n');

    const cache = new HashCache(cacheDirectory);
    expect(cache.size).toBe(0);
    cache.set(statOf(filepath), CHECKSUM_A);
    cache.close();

    const reopened = new HashCache(cacheDirectory);
    expect(reopened.get(statOf(filepath))).toBe(CHECKSUM_A);
    reopened.close();
  });

  describe('clearHashCache', () => {
    it('deletes the cache and reports that it did', () => {
      const cache = new HashCache(cacheDirectory);
      cache.set(statOf(filepath), CHECKSUM_A);
      cache.close();

      expect(clearHashCache(cacheDirectory)).toBe(1);
      expect(fs.existsSync(path.join(cacheDirectory, 'hash-cache.jsonl'))).toBe(false);

      const reopened = new HashCache(cacheDirectory);
      expect(reopened.size).toBe(0);
      reopened.close();
    });

    it('reports when there was nothing to delete', () => {
      expect(clearHashCache(cacheDirectory)).toBe(0);
    });
  });
});
