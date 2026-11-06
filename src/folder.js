// Auto-save to a folder you pick (File System Access API: Chrome and Edge on a computer).
// Every save writes benchbook-backup.json there. Before each write the file is re-read, and nothing is
// overwritten unless this browser already holds everything in it (see canAutosave).
import { db, persist, hooks, ensureBatch } from './shared.js';
import { buildBackup, parseBackup, mergeBackup, canAutosave } from './backup.js';

const FILE = 'benchbook-backup.json';
export const supported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;
/** status: off | ok | needs-permission | conflict | error */
export const state = { status: 'off', name: '', lastSaved: null, message: '', missing: [], fileBackup: null };

const listeners = new Set();
export const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach(f => { try { f(); } catch { /* a view error must not stop saving */ } });

let handle = null;
let timer = null;
let queue = Promise.resolve();

/* handles survive reloads in IndexedDB; the permission to use them has to be re-granted by a click */
const idb = () => new Promise((res, rej) => {
  const r = indexedDB.open('benchbook-handles', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('h');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const idbDo = async (mode, fn) => {
  const d = await idb();
  return new Promise((res, rej) => {
    const req = fn(d.transaction('h', mode).objectStore('h'));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
};

async function readFolderFile() {
  try {
    const fh = await handle.getFileHandle(FILE);
    return parseBackup(await (await fh.getFile()).text());
  } catch (e) {
    if (e.name === 'NotFoundError') return null;
    throw e;
  }
}

async function writeFile() {
  const fh = await handle.getFileHandle(FILE, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(buildBackup(db), null, 1));
  await w.close();
  state.lastSaved = Date.now();
  state.message = '';
}

/** Check the folder file against this browser, then write if that is safe. */
async function checkAndWrite() {
  if (!handle) return;
  try {
    const file = await readFolderFile();
    const c = canAutosave(file, db);
    if (!c.ok) { Object.assign(state, { status: 'conflict', fileBackup: file, missing: c.missing }); return; }
    Object.assign(state, { status: 'ok', fileBackup: null, missing: [] });
    await writeFile();
  } catch (e) {
    Object.assign(state, { status: 'error', message: e.message || String(e) });
  }
}

const run = () => { queue = queue.then(checkAndWrite).then(emit); return queue; };

hooks.afterPersist = () => {
  if (state.status !== 'ok') return;
  clearTimeout(timer);
  timer = setTimeout(run, 1200);
};

export async function init() {
  if (!supported) return;
  try { handle = await idbDo('readonly', s => s.get('folder')); } catch { handle = null; }
  if (!handle) return;
  state.name = handle.name;
  const perm = await handle.queryPermission?.({ mode: 'readwrite' });
  if (perm === 'granted') await run();
  else { state.status = 'needs-permission'; emit(); }
}

export async function connect() {
  let h;
  try { h = await window.showDirectoryPicker({ id: 'benchbook', mode: 'readwrite' }); } catch (e) { if (e.name === 'AbortError') return; throw e; }
  handle = h;
  state.name = h.name;
  try { await idbDo('readwrite', s => s.put(h, 'folder')); } catch { state.message = 'the folder will need to be picked again after a reload'; }
  await run();
}

export async function reconnect() {
  if (!handle) return;
  const perm = await handle.requestPermission?.({ mode: 'readwrite' });
  if (perm === 'granted') await run();
  else { state.message = 'permission was not granted'; emit(); }
}

/** Conflict: bring the folder file's missing batches and protocols into this browser, then carry on saving. */
export async function mergeFromFolder() {
  const res = mergeBackup(db, state.fileBackup);
  Object.values(db.batches).forEach(ensureBatch);
  persist();
  await run();
  return res;
}

/** Conflict or error: the person chose this browser's data over the folder's file. */
export async function overwriteFolder() {
  if (!handle) return;
  try {
    Object.assign(state, { status: 'ok', fileBackup: null, missing: [] });
    await writeFile();
  } catch (e) { Object.assign(state, { status: 'error', message: e.message || String(e) }); }
  emit();
}

export const saveNow = () => run();

export async function disconnect() {
  handle = null;
  clearTimeout(timer);
  try { await idbDo('readwrite', s => s.delete('folder')); } catch { /* nothing stored */ }
  Object.assign(state, { status: 'off', name: '', fileBackup: null, missing: [], message: '' });
  emit();
}
