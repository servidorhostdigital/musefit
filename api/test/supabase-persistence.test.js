import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';
import { prepareSupabasePersistence } from '../supabase-persistence.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('Supabase persistence hydrates, uploads and removes DATA_DIR files', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'musefit-persistence-'));
  const remote = new Map([['db.json', Buffer.from('{"users":[]}')]]);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (status, body = '') => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (req.method === 'GET' && url.pathname === '/storage/v1/bucket/musefit-data') return send(404, {});
    if (req.method === 'POST' && url.pathname === '/storage/v1/bucket') return send(200, {});
    if (req.method === 'POST' && url.pathname === '/storage/v1/object/list/musefit-data') {
      const rows = [...remote.keys()].map(name => ({ name, id: 'object', metadata: { size: remote.get(name).length } }));
      return send(200, rows);
    }
    if (url.pathname.startsWith('/storage/v1/object/musefit-data/')) {
      const object = decodeURIComponent(url.pathname.slice('/storage/v1/object/musefit-data/'.length));
      if (req.method === 'GET') {
        const value = remote.get(object);
        if (!value) return send(404, {});
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        return res.end(value);
      }
      if (req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        remote.set(object, Buffer.concat(chunks));
        return send(200, {});
      }
      if (req.method === 'DELETE') {
        remote.delete(object);
        return send(200, {});
      }
    }
    send(404, {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const previous = {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY,
    bucket: process.env.SUPABASE_STORAGE_BUCKET,
  };
  process.env.SUPABASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  process.env.SUPABASE_STORAGE_BUCKET = 'musefit-data';

  let persistence;
  try {
    persistence = await prepareSupabasePersistence(root);
    assert.equal(persistence.enabled, true);
    assert.equal(await fs.promises.readFile(path.join(root, 'db.json'), 'utf8'), '{"users":[]}');

    await fs.promises.writeFile(path.join(root, 'state-user.json'), '{"_rev":1}');
    await wait(1200);
    assert.equal(remote.get('state-user.json')?.toString(), '{"_rev":1}');

    await fs.promises.unlink(path.join(root, 'state-user.json'));
    await wait(3000);
    assert.equal(remote.has('state-user.json'), false);
  } finally {
    persistence?.close();
    await new Promise(resolve => server.close(resolve));
    await fs.promises.rm(root, { recursive: true, force: true });
    if (previous.url == null) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previous.url;
    if (previous.key == null) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previous.key;
    if (previous.bucket == null) delete process.env.SUPABASE_STORAGE_BUCKET; else process.env.SUPABASE_STORAGE_BUCKET = previous.bucket;
  }
});
