import { diffBatches } from './diff.js';
import { summarize } from './qc.js';
import { fmt } from './calc.js';
import { batchDate } from './overview.js';
import { db, esc, own } from './shared.js';

const byDate = () => Object.values(db.batches).sort((a, b) => batchDate(a).localeCompare(batchDate(b)));
const setLine = s => (s ? `${s.n} · median ${fmt(s.median, 1)} · ${fmt(s.min, 1)}–${fmt(s.max, 1)} · ${s.flagged} flagged` : '<span class="muted">not measured</span>');

export function renderCompare(aId, bId) {
  document.body.className = 'bench';
  const list = byDate();
  if (list.length < 2) return '<h1>Compare batches</h1><div class="empty">You need at least two batches to compare.</div>';
  const a = own(db.batches, aId) || list[list.length - 2];
  const b = own(db.batches, bId) || list[list.length - 1];
  const opts = id => list.map(x => `<option value="${esc(x.id)}" ${x.id === id ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  const d = diffBatches(a, b, { summarizeSet: rows => summarize(rows, db.settings.qc) });
  const changed = d.settings.filter(r => r.changed);
  const grouped = new Map();
  for (const c of d.protocol) grouped.set(c.where, [...(grouped.get(c.where) || []), c]);
  const noteList = n => n.list.filter(x => x.tag !== 'observation').map(x => `<div class="note ${esc(x.tag)}"><span class="tag">${esc(x.tag)}</span>${esc(x.text)}</div>`).join('') || '<span class="muted small">no ideas, deviations or errors</span>';
  const counts = n => ['idea', 'deviation', 'error', 'observation'].map(t => `${n.counts[t] || 0} ${t}`).join(' · ');
  return `<h1>Compare batches</h1>
  <div class="card"><div class="grid"><label class="field">Earlier<select data-chg="cmp-pick" data-side="a">${opts(a.id)}</select></label>
    <label class="field">Later<select data-chg="cmp-pick" data-side="b">${opts(b.id)}</select></label></div></div>
  <h2>Settings</h2><div class="card"><div class="tablewrap"><table><thead><tr><th></th><th>${esc(a.name)}</th><th>${esc(b.name)}</th></tr></thead><tbody>
    ${d.settings.map(r => `<tr class="${r.changed ? 'changed' : 'same'}"><td>${esc(r.label)}</td><td>${esc(r.a) || '–'}</td><td>${esc(r.b) || '–'}</td></tr>`).join('')}</tbody></table></div>
    <p class="hint">${changed.length ? `${changed.length} setting${changed.length === 1 ? '' : 's'} differ (highlighted).` : 'Same settings.'}</p></div>
  <h2>Protocol changes</h2>
  ${d.protocol.length ? `<div class="card">${[...grouped.entries()].map(([where, cs]) => `<div class="diffgroup"><b>${esc(where)}</b>${cs.map(c => `<div class="diff ${c.kind}">${c.kind === 'changed' ? `${esc(c.what)}: <s>${esc(c.from)}</s> → <b>${esc(c.to)}</b>` : `${c.kind} ${esc(c.what)}`}</div>`).join('')}</div>`).join('')}</div>`
    : `<div class="card ok">The two batches used the same protocol steps and numbers${a.protocol.revision !== b.protocol.revision ? ' (the revision differs)' : ''}.</div>`}
  <h2>Quality control</h2>
  ${d.qc.length ? `<div class="card"><div class="tablewrap"><table><thead><tr><th>Measured</th><th>${esc(a.name)}</th><th>${esc(b.name)}</th></tr></thead><tbody>${d.qc.map(q => `<tr><td>${esc(q.label)}</td><td>${setLine(q.a)}</td><td>${setLine(q.b)}</td></tr>`).join('')}</tbody></table></div><p class="hint">Samples · median ng/µL · range · flagged by the QC thresholds.</p></div>` : '<div class="empty">No QC measurements in either batch.</div>'}
  <h2>Notes</h2>
  <div class="grid"><div class="card"><h3>${esc(a.name)}</h3><div class="muted small">${counts(d.notes.a)}</div><div class="notes">${noteList(d.notes.a)}</div></div>
    <div class="card"><h3>${esc(b.name)}</h3><div class="muted small">${counts(d.notes.b)}</div><div class="notes">${noteList(d.notes.b)}</div></div></div>`;
}

export const changes = {
  'cmp-pick': el => {
    const card = el.closest('.card');
    location.hash = `#/compare/${card.querySelector('[data-side=a]').value}/${card.querySelector('[data-side=b]').value}`;
    return 'none';
  },
};
