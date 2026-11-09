// State and helpers shared by the app and its tab views.
import { DEFAULT_THRESHOLDS } from './qc.js';
import { defaultPlate } from './plate.js';

const KEY = 'benchbook.v1';

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}

/** The one database object: { batches, plates, settings }. Mutate it, then call persist(). */
export const db = load();
db.batches ??= {};
db.plates ??= {};   // index plates: { id, name, flags: { well: reason } }, shared by every batch
db.protocols ??= {}; // protocols you made or edited: { id: protocol }
db.settings ??= {};
db.settings.deleted ??= {}; // ids removed on purpose, so a backup folder does not resurrect them
db.settings.qc = { ...DEFAULT_THRESHOLDS, ...db.settings.qc };

/** Other modules (the backup folder) register here to be told after every save. */
export const hooks = { afterPersist: null, render: () => {}, loadProtocol: async () => null };

export function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* private mode: stays in memory */ }
  try { hooks.afterPersist?.(); } catch { /* a backup problem must never block saving */ }
}

/** Older batches (and imports) may lack the QC and plate sections. */
export function ensureBatch(b) {
  b.qc ??= { sets: [] };
  b.qc.sets ??= [];
  b.plate = { ...defaultPlate(), ...b.plate };
  return b;
}
Object.values(db.batches).forEach(ensureBatch);

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Dates only ("2026-08-10", from imported history) show as a date; full timestamps show the time too. */
export const clock = iso => {
  if (!iso) return '';
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (day) return new Date(+day[1], +day[2] - 1, +day[3]).toLocaleDateString([], { month: 'short', day: 'numeric' });
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
export const newId = prefix => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export function download(name, text, type = 'application/json') {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  a.click();
  URL.revokeObjectURL(a.href);
}
