import {
  BigIntStats,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * A persistent, server-independent cache of file checksums.
 *
 * Hashing a media library is disk bound: reading the bytes costs roughly seven times more than
 * sha1-ing them, so the only worthwhile saving is not reading bytes that have not changed. An
 * entry is keyed on the file's identity — device, inode, size and nanosecond mtime — rather than
 * its path, so a renamed or moved file still hits and two different files can never collide on
 * one key by sharing a name.
 *
 * A checksum is a property of the bytes, not of any Immich instance, so entries are deliberately
 * NOT scoped to a server and are reused across every instance the CLI talks to. Nothing derived
 * from the server (whether it already holds the asset, the asset id) is cached — only the
 * file-to-checksum mapping.
 *
 * **This cache is never authoritative for deletion.** Nanosecond mtime is a good change detector
 * but not an airtight one: `touch -r`, `rsync --times`, some editors and some restore tools put
 * the old timestamp back on new content, and a few filesystems only record whole seconds. A
 * stale hit that reached `--delete-duplicates` would unlink a local file whose current contents
 * the server has never seen, so the caller must re-hash anything it is about to delete on the
 * strength of a cached checksum. See `verifyDuplicates` in `src/commands/asset.ts`.
 */

const CACHE_FILE_NAME = 'hash-cache.jsonl';
const LOCK_FILE_NAME = 'hash-cache.lock';

/** Entries unused for this long are dropped when the log is next compacted. */
const ENTRY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Hard ceiling on live entries, oldest-used first. ~100 bytes each, so ~50 MB of log. */
const MAX_ENTRIES = 500_000;
/**
 * Appends are flushed once this many bytes are buffered. Kept well under 4 KiB so that every
 * `write(2)` to the O_APPEND file descriptor is a single, indivisible append: that is what makes
 * concurrent `immich upload` runs safe to interleave without a lock. See the note on the class.
 */
const FLUSH_BYTES = 3500;
/** ...and at least this often, so a cancelled run keeps almost everything it hashed. */
const FLUSH_INTERVAL_MS = 1000;
/** A hit older than this is re-appended so that files still in use never age out. */
const TOUCH_INTERVAL_SECONDS = 24 * 60 * 60;
/** A compaction lock left behind by a killed process is broken after this long. */
const STALE_LOCK_MS = 60_000;
/** Below this many lines, compaction is not worth the rewrite. */
const COMPACT_MIN_LINES = 1000;

const CHECKSUM_PATTERN = /^[\da-f]{40}$/;
const DIGITS_PATTERN = /^\d+$/;

/** One line of the log. Keys are short because there is one per file per run. */
interface CacheRecord {
  /** Device id. */
  d: string;
  /** Inode. */
  i: string;
  /** Size in bytes. */
  s: string;
  /** Modification time in nanoseconds. */
  m: string;
  /** The sha1 checksum, lowercase hex. */
  c: string;
  /** Unix time in seconds when the entry was last used, for ageing out. */
  t: number;
}

// dev, ino, size and mtimeNs are all bigints, so they are stored as decimal strings: JSON has no
// bigint, and an inode on XFS or btrfs can exceed Number.MAX_SAFE_INTEGER.
const keyOf = (stats: BigIntStats) => `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}`;
const keyOfRecord = (record: CacheRecord) => `${record.d}:${record.i}:${record.s}:${record.m}`;

const isDigits = (value: unknown): value is string => typeof value === 'string' && DIGITS_PATTERN.test(value);

/**
 * Validates a parsed line strictly. A torn or interleaved append must degrade to a cache miss and
 * never to a wrong checksum, so anything that is not exactly the expected shape is discarded.
 */
const isCacheRecord = (value: unknown): value is CacheRecord => {
  if (typeof value !== 'object' || !value) {
    return false;
  }

  const record = value as Partial<CacheRecord>;
  return (
    isDigits(record.d) &&
    isDigits(record.i) &&
    isDigits(record.s) &&
    isDigits(record.m) &&
    typeof record.c === 'string' &&
    CHECKSUM_PATTERN.test(record.c) &&
    typeof record.t === 'number' &&
    Number.isFinite(record.t)
  );
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * The cache lives under `$XDG_CACHE_HOME/immich/`, falling back to `~/.cache/immich/` — not beside
 * `auth.yml` in the config directory, because a cache is disposable and credentials are not.
 */
export const getCacheDirectory = () => {
  const xdgCacheHome = process.env.XDG_CACHE_HOME;
  const base = xdgCacheHome && xdgCacheHome.length > 0 ? xdgCacheHome : join(homedir(), '.cache');
  return join(base, 'immich');
};

/**
 * An append-only JSONL log, compacted on load.
 *
 * The format is deliberately dependency-free. `bun:sqlite` is unavailable (this runs under Node)
 * and `node:sqlite` cannot be used either: `packages/cli` declares `engines.node >= 22.0.0`, and
 * `node:sqlite` does not exist at all before 22.5 and is flagged experimental after it. A plain
 * append-only log needs nothing but `node:fs`, is written incrementally so a cancelled run keeps
 * what it hashed, and recovers from a partial write by dropping the unparseable line.
 *
 * **Concurrency.** Several `immich upload` runs may be in flight at once, and `--watch` keeps one
 * alive indefinitely, so the log is designed to tolerate interleaving rather than to exclude it:
 * every append is a single `write(2)` of well under 4 KiB to a descriptor opened with O_APPEND,
 * which the kernel will not split or reorder against another appender. Readers keep the last
 * record for a key, so two processes recording the same file simply agree. The one operation that
 * cannot interleave — compaction, which rewrites the whole file — is taken under an exclusive
 * lock file and skipped entirely if the lock is held. A run that skips compaction is still
 * correct, just reading a longer log. The residual loss is that appends made by another process
 * between our read and our rename are dropped; that costs a future re-hash and nothing else.
 */
export class HashCache {
  private readonly entries = new Map<string, CacheRecord>();
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly directory: string;

  private fileDescriptor?: number;
  private pending: string[] = [];
  private pendingBytes = 0;
  private timer?: NodeJS.Timeout;
  private readonly onExit = () => this.flush();

  hits = 0;
  misses = 0;
  hitBytes = 0;

  constructor(directory: string = getCacheDirectory()) {
    this.directory = directory;
    this.filePath = join(directory, CACHE_FILE_NAME);
    this.lockPath = join(directory, LOCK_FILE_NAME);
    this.load();
    process.on('exit', this.onExit);
  }

  /** The number of entries held in memory, exposed for tests and diagnostics. */
  get size() {
    return this.entries.size;
  }

  /** Returns the cached checksum for exactly these stats, or undefined. */
  get(stats: BigIntStats): string | undefined {
    const entry = this.entries.get(keyOf(stats));
    if (!entry) {
      this.misses++;
      return undefined;
    }

    this.hits++;
    this.hitBytes += Number(stats.size);

    const now = nowSeconds();
    if (now - entry.t > TOUCH_INTERVAL_SECONDS) {
      entry.t = now;
      this.append(entry);
    }

    return entry.c;
  }

  /** Records a freshly computed checksum. Written to the log immediately, not at the end of the run. */
  set(stats: BigIntStats, checksum: string) {
    const record: CacheRecord = {
      d: String(stats.dev),
      i: String(stats.ino),
      s: String(stats.size),
      m: String(stats.mtimeNs),
      c: checksum,
      t: nowSeconds(),
    };

    this.entries.set(keyOfRecord(record), record);
    this.append(record);
  }

  /** Writes everything buffered so far. Safe to call at any time, including from an exit handler. */
  flush() {
    this.clearTimer();
    if (this.pending.length === 0) {
      return;
    }

    const payload = this.pending.join('');
    this.pending = [];
    this.pendingBytes = 0;

    try {
      if (this.fileDescriptor === undefined) {
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        this.fileDescriptor = openSync(this.filePath, 'a', 0o600);
      }
      writeSync(this.fileDescriptor, payload);
    } catch {
      // The cache is advisory. A log we cannot write costs a re-hash next run, nothing worse.
    }
  }

  /** Flushes and releases the file descriptor. */
  close() {
    this.flush();
    process.removeListener('exit', this.onExit);

    if (this.fileDescriptor !== undefined) {
      try {
        closeSync(this.fileDescriptor);
      } catch {
        // already gone
      }
      this.fileDescriptor = undefined;
    }
  }

  private append(record: CacheRecord) {
    const line = JSON.stringify(record) + '\n';
    this.pending.push(line);
    this.pendingBytes += Buffer.byteLength(line);

    if (this.pendingBytes >= FLUSH_BYTES) {
      this.flush();
      return;
    }

    if (!this.timer) {
      // unref so a buffered write never keeps the process alive on its own
      this.timer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS).unref();
    }
  }

  private clearTimer() {
    if (!this.timer) {
      return;
    }

    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private load() {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch {
      // No cache yet, or it is unreadable. Either way, start empty.
      return;
    }

    const cutoff = (Date.now() - ENTRY_MAX_AGE_MS) / 1000;
    let lines = 0;

    for (const line of raw.split('\n')) {
      if (line.length === 0) {
        continue;
      }
      lines++;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A line torn by a partial write, or two appends spliced together. Drop it.
        continue;
      }

      if (!isCacheRecord(parsed) || parsed.t < cutoff) {
        continue;
      }

      // Later lines win, which is how an updated checksum for the same key supersedes an older one.
      this.entries.set(keyOfRecord(parsed), parsed);
    }

    this.evictOverflow();

    if (lines >= COMPACT_MIN_LINES && lines > this.entries.size * 2) {
      this.compact();
    }
  }

  private evictOverflow() {
    if (this.entries.size <= MAX_ENTRIES) {
      return;
    }

    const newestFirst = [...this.entries].toSorted(([, a], [, b]) => b.t - a.t);
    this.entries.clear();
    for (const [key, record] of newestFirst.slice(0, MAX_ENTRIES)) {
      this.entries.set(key, record);
    }
  }

  private compact() {
    if (!this.acquireLock()) {
      return;
    }

    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      let body = '';
      for (const record of this.entries.values()) {
        body += JSON.stringify(record) + '\n';
      }
      writeFileSync(temporaryPath, body, { mode: 0o600 });
      renameSync(temporaryPath, this.filePath);
    } catch {
      // Leave the log as it is: an uncompacted log is slower to read, never wrong.
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        // nothing more to do
      }
    } finally {
      this.releaseLock();
    }
  }

  private acquireLock(): boolean {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        closeSync(openSync(this.lockPath, 'wx', 0o600));
        return true;
      } catch {
        try {
          if (Date.now() - statSync(this.lockPath).mtimeMs > STALE_LOCK_MS) {
            // Left behind by a process that was killed mid-compaction.
            unlinkSync(this.lockPath);
            continue;
          }
        } catch {
          // The lock vanished under us, or the directory is unusable; one more try settles it.
          continue;
        }
        return false;
      }
    }

    return false;
  }

  private releaseLock() {
    try {
      unlinkSync(this.lockPath);
    } catch {
      // already gone
    }
  }
}

/** Deletes the cache from disk. Returns the number of files removed, so zero means there was none. */
export const clearHashCache = (directory: string = getCacheDirectory()): number => {
  const filePath = join(directory, CACHE_FILE_NAME);
  try {
    statSync(filePath);
  } catch {
    return 0;
  }

  rmSync(filePath, { force: true });
  rmSync(join(directory, LOCK_FILE_NAME), { force: true });
  return 1;
};
