/*
 * Durable persistence for the Vercel service.
 *
 * The API was designed around a local DATA_DIR so that self-hosted installs can
 * keep the whole instance on a mounted volume. Vercel service containers do not
 * provide that durable volume, so this adapter mirrors DATA_DIR to a private
 * Supabase Storage bucket. The application keeps its existing synchronous file
 * model; boot hydrates the local directory, and every later file change is
 * uploaded or removed asynchronously.
 *
 * The service-role key is deliberately server-only. No browser code uses this
 * module and the bucket remains private.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const RETRY_MS = 2000;
const LIST_LIMIT = 1000;

const cleanUrl = value => String(value || '').trim().replace(/\/+$/, '');
const safeBucket = value => {
  const bucket = String(value || 'musefit-data').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/.test(bucket) ? bucket : 'musefit-data';
};

const config = () => ({
  url: cleanUrl(process.env.SUPABASE_URL),
  key: String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
  bucket: safeBucket(process.env.SUPABASE_STORAGE_BUCKET),
});

const headersFor = key => ({
  apikey: key,
  authorization: `Bearer ${key}`,
});

const relative = (root, file) => {
  const rel = path.relative(root, file).split(path.sep).join('/');
  if (!rel || rel.startsWith('../') || rel === '..' || path.isAbsolute(rel)) return null;
  return rel;
};

const objectUrl = (cfg, object) => `${cfg.url}/storage/v1/object/${encodeURIComponent(cfg.bucket)}/${object.split('/').map(encodeURIComponent).join('/')}`;
const listUrl = cfg => `${cfg.url}/storage/v1/object/list/${encodeURIComponent(cfg.bucket)}`;
const bucketUrl = cfg => `${cfg.url}/storage/v1/bucket/${encodeURIComponent(cfg.bucket)}`;

async function bodyText(response) {
  try { return (await response.text()).slice(0, 500); } catch { return ''; }
}

async function ensureBucket(cfg) {
  const probe = await fetch(bucketUrl(cfg), { headers: headersFor(cfg.key) });
  if (probe.ok) return;
  if (probe.status !== 404) throw new Error(`Supabase Storage bucket check failed (${probe.status})`);
  const created = await fetch(`${cfg.url}/storage/v1/bucket`, {
    method: 'POST',
    headers: { ...headersFor(cfg.key), 'content-type': 'application/json' },
    body: JSON.stringify({ id: cfg.bucket, name: cfg.bucket, public: false }),
  });
  if (!created.ok && created.status !== 409) {
    throw new Error(`Supabase Storage bucket creation failed (${created.status})`);
  }
}

async function listPrefix(cfg, prefix = '') {
  const objects = [];
  for (let offset = 0;; offset += LIST_LIMIT) {
    const response = await fetch(listUrl(cfg), {
      method: 'POST',
      headers: { ...headersFor(cfg.key), 'content-type': 'application/json' },
      body: JSON.stringify({
        prefix,
        limit: LIST_LIMIT,
        offset,
        sortBy: { column: 'name', order: 'asc' },
      }),
    });
    if (!response.ok) throw new Error(`Supabase Storage list failed (${response.status}) ${await bodyText(response)}`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('Supabase Storage list returned an invalid response');
    for (const row of rows) {
      const name = typeof row?.name === 'string' ? row.name : '';
      if (!name) continue;
      const child = `${prefix}${name}`;
      // Storage returns folders as rows without an object id/metadata. Walking
      // them explicitly works on both the hosted API and the local emulator.
      if (row.id == null && row.metadata == null) objects.push(...await listPrefix(cfg, `${child}/`));
      else objects.push(child);
    }
    if (rows.length < LIST_LIMIT) break;
  }
  return objects;
}

function localFiles(root) {
  const result = [];
  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.endsWith('.tmp') || entry.name.includes('.unreadable-') || entry.name.includes('.remote-')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && relative(root, full)) result.push(full);
    }
  };
  walk(root);
  return result;
}

async function downloadObject(cfg, root, object) {
  const destination = path.join(root, ...object.split('/'));
  if (!relative(root, destination)) throw new Error(`Unsafe Supabase Storage object path: ${object}`);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.remote-${process.pid}-${Date.now()}`;
  const response = await fetch(objectUrl(cfg, object), { headers: headersFor(cfg.key) });
  if (!response.ok || !response.body) throw new Error(`Supabase Storage download failed (${response.status})`);
  try {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary, { mode: 0o600 }));
    fs.renameSync(temporary, destination);
    try { fs.chmodSync(destination, 0o600); } catch { /* best effort on mounted filesystems */ }
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* already renamed or absent */ }
  }
}

async function uploadFile(cfg, root, file) {
  const object = relative(root, file);
  if (!object) return;
  const stat = await fs.promises.stat(file);
  const body = Readable.toWeb(fs.createReadStream(file));
  const response = await fetch(objectUrl(cfg, object), {
    method: 'POST',
    headers: {
      ...headersFor(cfg.key),
      'content-type': 'application/octet-stream',
      'content-length': String(stat.size),
      'x-upsert': 'true',
    },
    body,
    duplex: 'half',
  });
  if (!response.ok) throw new Error(`Supabase Storage upload failed (${response.status}) ${await bodyText(response)}`);
}

async function removeFile(cfg, root, file) {
  const object = relative(root, file);
  if (!object) return;
  const response = await fetch(objectUrl(cfg, object), { method: 'DELETE', headers: headersFor(cfg.key) });
  if (!response.ok && response.status !== 404) throw new Error(`Supabase Storage delete failed (${response.status})`);
}

export async function prepareSupabasePersistence(dataDir) {
  const cfg = config();
  if (!cfg.url && !cfg.key) return { enabled: false };
  if (!cfg.url || !cfg.key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set together');

  await fs.promises.mkdir(dataDir, { recursive: true });
  await ensureBucket(cfg);
  const remote = await listPrefix(cfg);
  const local = localFiles(dataDir);

  // A brand-new Supabase project may be paired with an existing self-hosted
  // instance. Seed the bucket once from DATA_DIR instead of silently replacing
  // that data with an empty remote directory.
  if (remote.length === 0 && local.length > 0) {
    for (const file of local) await uploadFile(cfg, dataDir, file);
  } else {
    const remoteSet = new Set(remote);
    for (const file of local) {
      const object = relative(dataDir, file);
      if (object && !remoteSet.has(object)) {
        try { fs.unlinkSync(file); } catch { /* another boot task may have removed it */ }
      }
    }
    for (const object of remote) await downloadObject(cfg, dataDir, object);
  }

  const pending = new Map();
  const watchers = new Map();
  let closed = false;

  const sync = async file => {
    if (closed) return;
    try {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) await uploadFile(cfg, dataDir, file);
      else await removeFile(cfg, dataDir, file);
    } catch (error) {
      console.error('supabase persistence sync failed:', error.message, error.cause?.code || '');
      const timer = setTimeout(() => { pending.delete(file); schedule(file); }, RETRY_MS);
      timer.unref?.();
    }
  };

  const schedule = file => {
    if (!relative(dataDir, file) || path.basename(file).endsWith('.tmp') || path.basename(file).includes('.unreadable-') || path.basename(file).includes('.remote-')) return;
    clearTimeout(pending.get(file));
    const timer = setTimeout(() => { pending.delete(file); void sync(file); }, 350);
    timer.unref?.();
    pending.set(file, timer);
  };

  const watchDir = dir => {
    if (watchers.has(dir)) return;
    let watcher;
    try {
      watcher = fs.watch(dir, (_event, name) => {
        if (!name) return;
        const file = path.join(dir, String(name));
        try {
          if (fs.existsSync(file) && fs.statSync(file).isDirectory()) watchDir(file);
          else schedule(file);
        } catch { schedule(file); }
      });
    } catch (error) {
      console.error('supabase persistence watcher failed:', error.message);
      return;
    }
    watcher.on('error', error => console.error('supabase persistence watcher error:', error.message));
    watchers.set(dir, watcher);
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) if (entry.isDirectory() && entry.name !== '.tmp') watchDir(path.join(dir, entry.name));
  };

  watchDir(dataDir);
  return {
    enabled: true,
    bucket: cfg.bucket,
    close() {
      closed = true;
      for (const timer of pending.values()) clearTimeout(timer);
      for (const watcher of watchers.values()) watcher.close();
      pending.clear();
      watchers.clear();
    },
  };
}
