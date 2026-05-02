import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildApp } from '../../src/app.js';

let server;
let port;

before(async () => {
  const app = buildApp();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const request = (path) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
    let body = '';
    res.on('data', (c) => body += c);
    res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', reject);
  req.end();
});

test('GET /healthz returns ok', async () => {
  const res = await request('/healthz');
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
});

test('GET /api/v1/unknown returns 404 envelope', async () => {
  const res = await request('/api/v1/does-not-exist');
  assert.equal(res.status, 404);
  const body = JSON.parse(res.body);
  assert.equal(body.error.code, 'NOT_FOUND');
});
