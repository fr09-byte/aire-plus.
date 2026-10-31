import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createDevServer } from '../scripts/dev.mjs';
import { setup } from './helpers.js';

test('The local HTTP server serves extracted assets and the real subscribe route', async t => {
  await setup(t);
  const server = createDevServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  for (const [path, mime] of [
    ['/', 'text/html'], ['/assets/app.js', 'text/javascript'],
    ['/assets/styles.css', 'text/css'], ['/shared/air-core.js', 'text/javascript'],
  ]) {
    const result = await fetch(base + path);
    assert.equal(result.status, 200);
    assert.ok(result.headers.get('content-type').startsWith(mime));
    await result.text();
  }
  let result = await fetch(base + '/api/subscribe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(result.status, 400);
  assert.match((await result.json()).error, /Confirma/);
  result = await fetch(base + '/api/subscribe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '',
  });
  assert.equal(result.status, 400);
  await result.json();
  result = await fetch(base + '/api/alerts');
  assert.equal(result.status, 200);
  assert.ok(result.headers.get('set-cookie').includes('HttpOnly'));
  await result.json();
  for (const path of ['/.env', '/server/session.js', '/api/does-not-exist', '/assets/../.env']) {
    result = await fetch(base + path);
    assert.equal(result.status, 404);
    await result.text();
  }
});
