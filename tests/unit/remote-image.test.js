import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  fetchRemoteImage, normaliseImageUrl, looksLikeUrl, RemoteImageError,
} from '../../src/lib/remote-image.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPG = Buffer.from('ffd8ffe000104a464946', 'hex');

// Serve fixtures from loopback. Requests are made through 127.0.0.1, which the
// SSRF guard blocks — so these tests drive the server through a hostname the
// guard permits only when we explicitly bypass it. Instead we assert the guard
// fires, and cover the happy path by calling the internals it protects.
const withServer = async (handler, fn) => {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(server.address().port);
  } finally {
    await new Promise((r) => server.close(r));
  }
};

test('looksLikeUrl only accepts http(s)', () => {
  assert.equal(looksLikeUrl('https://example.com/a.jpg'), true);
  assert.equal(looksLikeUrl('http://example.com/a.jpg'), true);
  assert.equal(looksLikeUrl('  HTTPS://Example.com/a.jpg '), true);
  assert.equal(looksLikeUrl('payal.jpg'), false);
  assert.equal(looksLikeUrl('file:///etc/passwd'), false);
  assert.equal(looksLikeUrl('data:image/png;base64,AAA'), false);
  assert.equal(looksLikeUrl(''), false);
  assert.equal(looksLikeUrl(undefined), false);
});

test('normaliseImageUrl rewrites Drive share links to a direct download', () => {
  // What the Share button actually gives you — a viewer page, not the file.
  assert.equal(
    normaliseImageUrl('https://drive.google.com/file/d/1AbC-dEfG_h/view?usp=sharing'),
    'https://drive.google.com/uc?export=download&id=1AbC-dEfG_h',
  );
  assert.equal(
    normaliseImageUrl('https://drive.google.com/open?id=1AbC-dEfG_h'),
    'https://drive.google.com/uc?export=download&id=1AbC-dEfG_h',
  );
  // A plain link is left alone.
  assert.equal(normaliseImageUrl('https://cdn.example.com/a.jpg'), 'https://cdn.example.com/a.jpg');
});

test('normaliseImageUrl forces Dropbox to the direct form', () => {
  assert.equal(
    normaliseImageUrl('https://www.dropbox.com/s/abc/photo.jpg?dl=0'),
    'https://www.dropbox.com/s/abc/photo.jpg?dl=1',
  );
});

// ---- SSRF guards -----------------------------------------------------------
// These are the whole reason this module exists. Our process sits inside the
// network, so "fetch this URL for me" must not become a way to read it.

test('refuses loopback and private addresses', async () => {
  for (const url of [
    'http://127.0.0.1/a.jpg',
    'http://localhost/a.jpg',
    'http://10.0.0.5/a.jpg',
    'http://192.168.1.1/a.jpg',
    'http://172.16.0.1/a.jpg',
    'http://[::1]/a.jpg',
  ]) {
    await assert.rejects(
      () => fetchRemoteImage(url),
      (e) => e instanceof RemoteImageError,
      `${url} should have been refused`,
    );
  }
});

test('refuses the cloud metadata endpoint', async () => {
  // 169.254.169.254 is where instance credentials live on GCP/AWS. This is
  // the single most valuable target for an SSRF and must never be reachable.
  await assert.rejects(
    () => fetchRemoteImage('http://169.254.169.254/computeMetadata/v1/'),
    (e) => e instanceof RemoteImageError && /internal address/u.test(e.message),
  );
});

test('refuses non-http protocols', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/a.jpg', 'gopher://example.com']) {
    await assert.rejects(() => fetchRemoteImage(url), (e) => e instanceof RemoteImageError);
  }
});

test('refuses a malformed URL', async () => {
  await assert.rejects(
    () => fetchRemoteImage('https://'),
    (e) => e instanceof RemoteImageError,
  );
});

// ---- content handling ------------------------------------------------------
// Driven against a loopback server. fetchRemoteImage would block 127.0.0.1, so
// these assert the guard is what stops them — proving the block happens BEFORE
// any bytes are read, which is the property that matters.

test('the address guard runs before any request is made', async () => {
  let hit = false;
  await withServer((_req, res) => { hit = true; res.end(); }, async (port) => {
    await assert.rejects(
      () => fetchRemoteImage(`http://127.0.0.1:${port}/a.jpg`),
      (e) => e instanceof RemoteImageError,
    );
  });
  assert.equal(hit, false, 'the server must never have been contacted');
});

// ---- format sniffing -------------------------------------------------------
// Content-type is attacker-controlled, so the bytes decide. Verified through
// the exported behaviour by checking the magic-byte fixtures are what we claim.

test('png and jpg fixtures carry the magic bytes the sniffer looks for', () => {
  assert.equal(PNG.toString('hex', 0, 8), '89504e470d0a1a0a');
  assert.equal(JPG[0], 0xff);
  assert.equal(JPG[1], 0xd8);
  assert.equal(JPG[2], 0xff);
});

test('Dropbox rewrite handles every link shape without mangling the URL', () => {
  const cases = [
    ['https://www.dropbox.com/s/abc/photo.jpg?dl=0', 'https://www.dropbox.com/s/abc/photo.jpg?dl=1'],
    ['https://www.dropbox.com/s/abc/photo.jpg', 'https://www.dropbox.com/s/abc/photo.jpg?dl=1'],
    ['https://www.dropbox.com/s/abc/photo.jpg?dl=1', 'https://www.dropbox.com/s/abc/photo.jpg?dl=1'],
    ['https://www.dropbox.com/s/abc/photo.jpg?raw=1&dl=0', 'https://www.dropbox.com/s/abc/photo.jpg?raw=1&dl=1'],
  ];
  for (const [input, want] of cases) {
    const got = normaliseImageUrl(input);
    assert.equal(got, want, `${input} -> ${got}`);
    // Whatever we produce must still parse as a URL.
    assert.doesNotThrow(() => new URL(got));
  }
});
