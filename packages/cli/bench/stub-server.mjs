// A stand-in for the Immich API, just complete enough for `immich upload`.
//
// Per-upload latency is artificial and configurable, so that the network side of the pipeline can
// be modelled without a real server or a real uplink. It reports how long it was busy and how the
// requests were spaced, which is what the pipelining measurement actually needs.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const port = Number(process.env.STUB_PORT ?? 3999);
// Milliseconds the server holds an /assets POST open before answering.
const uploadDelayMs = Number(process.env.STUB_UPLOAD_DELAY_MS ?? 40);
// Milliseconds an /assets/bulk-upload-check POST takes.
const checkDelayMs = Number(process.env.STUB_CHECK_DELAY_MS ?? 50);
// Fraction of checked files the server claims it already has.
const duplicateRatio = Number(process.env.STUB_DUPLICATE_RATIO ?? 0);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const stats = {
  start: 0,
  uploads: 0,
  checks: 0,
  checkedFiles: 0,
  checkBatchSizes: [],
  firstUploadAt: undefined,
  lastUploadAt: undefined,
  lastCheckAt: undefined,
};

const readBody = (request) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });

const json = (response, body, status = 200) => {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  response.end(payload);
};

const since = () => Date.now() - stats.start;

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  // `/api/...` and `/...` both reach the same handlers; `/api-keys/me` must not be mangled.
  const route = url.pathname.replace(/^\/api(?=\/)/, '');

  if (route === '/__stats') {
    return json(response, stats);
  }

  if (route === '/__reset') {
    stats.start = Date.now();
    stats.uploads = 0;
    stats.checks = 0;
    stats.checkedFiles = 0;
    stats.checkBatchSizes = [];
    stats.firstUploadAt = undefined;
    stats.lastUploadAt = undefined;
    stats.lastCheckAt = undefined;
    return json(response, { ok: true });
  }

  if (route === '/users/me') {
    return json(response, { id: randomUUID(), email: 'bench@example.com', name: 'bench' });
  }

  if (route === '/api-keys/me') {
    return json(response, { id: randomUUID(), name: 'bench', permissions: ['all'] });
  }

  if (route === '/server/media-types') {
    return json(response, { image: ['.jpg', '.png'], video: ['.mp4'], sidecar: ['.xmp'] });
  }

  if (route === '/assets/bulk-upload-check' && request.method === 'POST') {
    const body = JSON.parse((await readBody(request)).toString());
    const assets = body.assets ?? [];

    stats.checks += 1;
    stats.checkedFiles += assets.length;
    stats.checkBatchSizes.push(assets.length);

    await sleep(checkDelayMs);
    stats.lastCheckAt = since();

    const results = assets.map((asset, index) =>
      index % 100 < duplicateRatio * 100
        ? { id: asset.id, action: 'reject', reason: 'duplicate', assetId: randomUUID() }
        : { id: asset.id, action: 'accept' },
    );
    return json(response, { results });
  }

  if (route === '/assets' && request.method === 'POST') {
    // Drain the multipart body: the CLI streams the file, so this is where the disk read happens.
    await readBody(request);
    await sleep(uploadDelayMs);

    stats.uploads += 1;
    stats.firstUploadAt ??= since();
    stats.lastUploadAt = since();
    return json(response, { id: randomUUID(), status: 'created' }, 201);
  }

  json(response, { message: `no stub for ${request.method} ${route}` }, 404);
});

stats.start = Date.now();
server.listen(port, () => console.log(`stub listening on ${port}`));
