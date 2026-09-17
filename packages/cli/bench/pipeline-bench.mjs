// Wall-clock comparison of the serial and pipelined upload paths against the stub server.
//
//   node bench/pipeline-bench.mjs <serial-bundle> <pipelined-bundle>
//
// Each bundle is a built `dist/index.js`. Every scenario is run `RUNS` times per bundle, on a
// freshly generated corpus, with the hash cache pointed at a throwaway directory so that a warm
// cache never leaks from one run into the next.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [, , serialBundle, pipelinedBundle] = process.argv;
if (!serialBundle || !pipelinedBundle) {
  console.error('usage: node bench/pipeline-bench.mjs <serial-bundle> <pipelined-bundle>');
  process.exit(1);
}

const RUNS = Number(process.env.RUNS ?? 3);
const PORT = Number(process.env.STUB_PORT ?? 3999);
const BASE_URL = `http://127.0.0.1:${PORT}`;

const median = (values) => {
  const sorted = [...values].toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

const makeCorpus = (count, sizeBytes) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'immich-bench-corpus-'));
  // One random block, sliced differently per file: incompressible, distinct checksums, and cheap
  // enough to generate that corpus creation is not itself the benchmark.
  const block = randomBytes(sizeBytes + count);
  for (let index = 0; index < count; index++) {
    // A folder per 500 files, so --album has something plausible to key on if it is ever measured.
    const folder = path.join(directory, `folder-${Math.floor(index / 500)}`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, `asset-${index}.jpg`), block.subarray(index, index + sizeBytes));
  }
  return directory;
};

const run = (bundle, corpus, cacheHome, concurrency, extraArgs = []) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(
      process.execPath,
      [bundle, 'upload', '--recursive', '--no-progress', '--concurrency', String(concurrency), ...extraArgs, corpus],
      {
        env: {
          ...process.env,
          IMMICH_INSTANCE_URL: BASE_URL,
          IMMICH_API_KEY: 'bench-key',
          XDG_CACHE_HOME: cacheHome,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`exit ${code}\n${stdout}\n${stderr}`));
        return;
      }
      resolve({ ms: Date.now() - started, stdout });
    });
  });

const stubStats = async () => (await fetch(`${BASE_URL}/__stats`)).json();
const resetStub = async () => {
  await fetch(`${BASE_URL}/__reset`);
};

const scenarios = [
  {
    // Six bulk-upload-check batches, and an upload cost that is almost all server-side wait, so
    // the client really is idle while it waits. This is the shape the change is meant to help.
    name: 'mostly-new, 30000 x 8 KiB, upload 8 ms, concurrency 32',
    files: 30_000,
    sizeBytes: 8 * 1024,
    uploadDelayMs: 8,
    checkDelayMs: 50,
    duplicateRatio: 0,
    concurrency: 32,
  },
  {
    // One full batch plus a tail: only a sixth of the hashing has anywhere to overlap into.
    name: 'mostly-new, 6000 x 64 KiB, upload 8 ms, concurrency 8',
    files: 6000,
    sizeBytes: 64 * 1024,
    uploadDelayMs: 8,
    checkDelayMs: 50,
    duplicateRatio: 0,
    concurrency: 8,
  },
  {
    // Fewer files than one batch, hashed faster than the idle interval: nothing can flush early,
    // so no overlap is possible at all. Kept to show that case honestly.
    name: 'mostly-new, 800 x 1 MiB, upload 30 ms, concurrency 4',
    files: 800,
    sizeBytes: 1024 * 1024,
    uploadDelayMs: 30,
    checkDelayMs: 50,
    duplicateRatio: 0,
    concurrency: 4,
  },
  {
    name: 'mostly-duplicates (90%), 6000 x 64 KiB, upload 8 ms, concurrency 8',
    files: 6000,
    sizeBytes: 64 * 1024,
    uploadDelayMs: 8,
    checkDelayMs: 50,
    duplicateRatio: 0.9,
    concurrency: 8,
  },
  {
    name: 'all-duplicates, 6000 x 64 KiB, concurrency 8',
    files: 6000,
    sizeBytes: 64 * 1024,
    uploadDelayMs: 8,
    checkDelayMs: 50,
    duplicateRatio: 1,
    concurrency: 8,
  },
];

const startStub = (scenario) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(import.meta.dirname, 'stub-server.mjs')], {
      env: {
        ...process.env,
        STUB_PORT: String(PORT),
        STUB_UPLOAD_DELAY_MS: String(scenario.uploadDelayMs),
        STUB_CHECK_DELAY_MS: String(scenario.checkDelayMs),
        STUB_DUPLICATE_RATIO: String(scenario.duplicateRatio),
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('stub listening')) {
        resolve(child);
      }
    });
    child.on('error', reject);
  });

const report = [];

for (const scenario of scenarios) {
  const stub = await startStub(scenario);
  // One corpus per scenario, reused by every run. Nothing here deletes or rewrites the files, and
  // regenerating multi-hundred-megabyte trees between runs was itself the largest source of
  // run-to-run variance on this machine.
  const corpus = makeCorpus(scenario.files, scenario.sizeBytes);
  const results = {
    hashOnly: { timings: [] },
    serial: { timings: [], details: [] },
    pipelined: { timings: [], details: [] },
  };

  const configs = [
    // The hash-and-check phase alone: --no-upload does everything except send the files. This is
    // the upper bound on what overlapping the two phases can ever save.
    ['hashOnly', serialBundle, ['--no-upload']],
    ['serial', serialBundle, []],
    ['pipelined', pipelinedBundle, []],
  ];

  try {
    for (let attempt = 0; attempt < RUNS; attempt++) {
      // Interleaved and rotated, so that no configuration always occupies the same slot. This host
      // is shared, and running all of one configuration before all of another let background load
      // drift show up as a difference between them.
      const order = configs.map((_, index) => configs[(index + attempt) % configs.length]);
      for (const [label, bundle, extraArgs] of order) {
        const cacheHome = mkdtempSync(path.join(os.tmpdir(), 'immich-bench-cache-'));
        try {
          await resetStub();
          const { ms } = await run(bundle, corpus, cacheHome, scenario.concurrency, extraArgs);
          const stats = await stubStats();
          results[label].timings.push(ms);
          results[label].details?.push({
            ms,
            checks: stats.checks,
            batches: stats.checkBatchSizes,
            firstUploadAt: stats.firstUploadAt,
            uploads: stats.uploads,
          });
        } finally {
          rmSync(cacheHome, { recursive: true, force: true });
        }
      }
    }
  } finally {
    rmSync(corpus, { recursive: true, force: true });
    // Wait for the port to actually be released before the next scenario binds it.
    const closed = new Promise((resolve) => stub.once('exit', resolve));
    stub.kill();
    await closed;
  }

  for (const [label] of configs) {
    results[label].median = median(results[label].timings);
    // The minimum matters as much as the median here. This machine carries other work, so every
    // timing is the true cost plus an unknown amount of contention; the fastest run is the one
    // least polluted by it, and it is the fairest comparison between two configurations.
    results[label].min = Math.min(...results[label].timings);
    console.log(
      `${scenario.name} | ${label}: ${results[label].timings.join(', ')} ms ` +
        `(median ${results[label].median}, min ${results[label].min})`,
    );
  }
  console.log(`  detail: ${JSON.stringify(results.pipelined.details[0])}`);

  report.push({ scenario: scenario.name, ...results });
}

console.log('\n=== SUMMARY ===');
for (const row of report) {
  const byMedian = ((row.pipelined.median - row.serial.median) / row.serial.median) * 100;
  const byMin = ((row.pipelined.min - row.serial.min) / row.serial.min) * 100;
  const spread = (timings) => `${Math.min(...timings)}-${Math.max(...timings)}`;
  console.log(
    `${row.scenario}\n` +
      `  hash+check only  median ${row.hashOnly.median} min ${row.hashOnly.min} (${spread(row.hashOnly.timings)})\n` +
      `  serial           median ${row.serial.median} min ${row.serial.min} (${spread(row.serial.timings)})\n` +
      `  pipelined        median ${row.pipelined.median} min ${row.pipelined.min} (${spread(row.pipelined.timings)})\n` +
      `  change: ${byMedian.toFixed(1)}% by median, ${byMin.toFixed(1)}% by min`,
  );
}
console.log('\n=== RAW ===');
console.log(JSON.stringify(report, undefined, 2));
