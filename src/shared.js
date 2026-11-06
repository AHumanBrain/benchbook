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
db.settings ??= {};
db.settings.qc = { ...DEFAULT_THRESHOLDS, ...db.settings.qc };

export function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* private mode: stays in memory */ }
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
export const clock = iso => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
export const newId = prefix => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export function download(name, text, type = 'application/json') {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  a.click();
  URL.revokeObjectURL(a.href);
}
