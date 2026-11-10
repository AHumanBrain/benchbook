// Backup file format, merging and the safety check for the auto-saved folder. Pure: no DOM, no storage.

import { isPristineSeed } from './seed.js';

export const FORMAT = 'benchbook-backup';

/** Ids end up in web addresses and attributes, so a file may only carry plain ones ("seed-b5-hyb", "bk3x9"). */
export const isSafeId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(id) && !(id in Object.prototype);

/** Throws a readable Error unless a batch from a file is safe to keep: plain ids, numeric counts. */
export function checkBatch(batch, id = batch?.id) {
  const say = why => { throw new Error(`batch "${String(id).slice(0, 40)}" ${why}`); };
  if (!batch || typeof batch !== 'object' || !batch.protocol || typeof batch.protocol !== 'object' || !batch.state || typeof batch.state !== 'object') say('is damaged');
  if (!isSafeId(id) || batch.id !== id) say('has an unusable id (letters, digits, - _ . only)');
  if (typeof batch.name !== 'string') say('has no name');
  if (!Number.isFinite(batch.n) || batch.n < 1 || batch.n > 384) say('has a reaction count that is not a number from 1 to 384');
  if (!Number.isFinite(batch.overagePct) || batch.overagePct < 0 || batch.overagePct > 50) say('has an overage that is not a number from 0 to 50');
  if (batch.links != null && !(Array.isArray(batch.links) && batch.links.every(isSafeId))) say('has damaged links');
}

/** The backup's version of a batch should replace ours: we have none, or ours is an untouched import and theirs is not. */
const backupWins = (local, fromFile) => !local || (isPristineSeed(local) && !isPristineSeed(fromFile));

export function buildBackup(db, now = new Date()) {
  return {
    format: FORMAT,
    version: 1,
    exported: now.toISOString(),
    batches: db.batches,
    plates: db.plates,
    protocols: db.protocols,
    deleted: db.settings?.deleted || {},
    settings: { qc: db.settings?.qc },
  };
}

/** Parse and sanity-check a backup file's text. Throws a readable Error. */
export function parseBackup(text) {
  let b;
  try { b = JSON.parse(text); } catch { throw new Error('this is not a JSON file'); }
  if (!b || b.format !== FORMAT) throw new Error('this is not a benchbook backup file');
  for (const k of ['batches', 'plates', 'protocols']) {
    if (b[k] && typeof b[k] !== 'object') throw new Error(`the "${k}" section is damaged`);
    b[k] ??= {};
  }
  b.deleted ??= {};
  for (const k of ['batches', 'plates', 'protocols']) {
    if (Array.isArray(b[k])) throw new Error(`the "${k}" section is damaged`);
  }
  for (const [id, batch] of Object.entries(b.batches)) checkBatch(batch, id);
  for (const [id, plate] of Object.entries(b.plates)) {
    if (!isSafeId(id) || !plate || plate.id !== id) throw new Error(`index plate "${id.slice(0, 40)}" is damaged or has an unusable id`);
  }
  for (const [id, p] of Object.entries(b.protocols)) {
    if (!isSafeId(id) || !p || p.id !== id) throw new Error(`protocol "${id.slice(0, 40)}" is damaged or has an unusable id`);
  }
  return b;
}

export const summary = b => ({ batches: Object.keys(b.batches || {}).length, protocols: Object.keys(b.protocols || {}).length, plates: Object.keys(b.plates || {}).length });

/** What merging would do, without doing it: ids that are new, and ids that exist in both. */
export function mergePlan(db, backup) {
  const plan = { newBatches: [], clashBatches: [], newProtocols: [], clashProtocols: [] };
  for (const [id, b] of Object.entries(backup.batches)) (backupWins(db.batches[id], b) ? plan.newBatches : plan.clashBatches).push(id);
  for (const id of Object.keys(backup.protocols)) (db.protocols[id] ? plan.clashProtocols : plan.newProtocols).push(id);
  return plan;
}

/** Add what is missing from `backup` into `db`. Existing ids are kept unless `overwrite`.
 *  Plates are merged flag by flag (this browser's reason wins). Returns counts. */
export function mergeBackup(db, backup, { overwrite = false } = {}) {
  const out = { added: 0, overwritten: 0, skipped: 0 };
  const put = (target, id, value, wins = !target[id]) => {
    if (wins) { target[id] = value; out.added++; } else if (overwrite) { target[id] = value; out.overwritten++; } else out.skipped++;
  };
  for (const [id, v] of Object.entries(backup.batches)) put(db.batches, id, v, backupWins(db.batches[id], v));
  for (const [id, v] of Object.entries(backup.protocols)) put(db.protocols, id, v);
  for (const [id, plate] of Object.entries(backup.plates)) {
    if (!db.plates[id]) db.plates[id] = plate;
    else db.plates[id].flags = { ...(plate.flags || {}), ...(db.plates[id].flags || {}) };
  }
  db.settings.deleted ??= {};
  for (const id of [...Object.keys(backup.batches), ...Object.keys(backup.protocols)]) delete db.settings.deleted[id]; // restored on purpose
  return out;
}

/** The folder file may only be overwritten automatically if this browser already holds everything in it
 *  (except things deleted on purpose). Otherwise an empty browser would wipe a good backup. */
export function canAutosave(fileBackup, db) {
  if (!fileBackup) return { ok: true, missing: [] };
  const deleted = db.settings?.deleted || {};
  const missing = [
    ...Object.entries(fileBackup.batches || {}).filter(([id, b]) => backupWins(db.batches[id], b) && !deleted[id]).map(([id]) => id),
    ...Object.keys(fileBackup.protocols || {}).filter(id => !db.protocols[id] && !deleted[id]),
  ];
  return { ok: missing.length === 0, missing };
}

/** Days since an ISO time, or null. */
export const daysSince = (iso, now = Date.now()) => (iso ? Math.floor((now - new Date(iso).getTime()) / 86400000) : null);

/** The state of the user's safety net, for the header chip. level: ok | warn | bad | none. */
export function backupStatus({ folder, lastExport, hasData, now = Date.now() }) {
  if (folder?.status === 'ok') return { level: 'ok', text: 'Auto-saved to folder', detail: folder.lastSaved ? `last saved ${new Date(folder.lastSaved).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'connected' };
  if (folder?.status === 'conflict') return { level: 'warn', text: 'Backup folder differs', detail: 'open to resolve' };
  if (folder?.status === 'needs-permission') return { level: 'warn', text: 'Reconnect backup folder', detail: 'the browser asks again after a restart' };
  if (folder?.status === 'error') return { level: 'bad', text: 'Folder backup failed', detail: folder.message || '' };
  if (!hasData) return { level: 'none', text: 'Backup', detail: '' };
  const d = daysSince(lastExport, now);
  if (d === null) return { level: 'warn', text: 'Not backed up', detail: 'export or pick a folder' };
  if (d >= 7) return { level: 'warn', text: `Last backup ${d} days ago`, detail: '' };
  return { level: 'ok', text: d === 0 ? 'Backed up today' : `Backed up ${d}d ago`, detail: '' };
}
