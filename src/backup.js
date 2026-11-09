// Backup file format, merging and the safety check for the auto-saved folder. Pure: no DOM, no storage.

import { isPristineSeed } from './seed.js';

export const FORMAT = 'benchbook-backup';

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
  for (const [id, batch] of Object.entries(b.batches)) {
    if (!batch || !batch.protocol || !batch.state) throw new Error(`batch "${id}" is damaged`);
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
