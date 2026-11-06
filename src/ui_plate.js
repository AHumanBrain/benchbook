import { fmt } from './calc.js';
import * as P from './plate.js';
import { esc, db, persist, download, newId } from './shared.js';

const root = () => document.getElementById('app');
const plateOf = b => db.plates[b.plate.plateId] || null;
const qcSet = b => b.qc.sets.find(s => s.id === b.plate.qcSetId) || null;
const poolColor = p => `hsl(${(p * 47 + 160) % 360} 55% 50%)`;
const key = s => String(s).trim().toLowerCase();

function context(b) {
  const pl = plateOf(b);
  return { pl, flags: pl?.flags || {}, uses: pl ? P.plateUses(db.batches, pl.id, b.id) : new Map(), rows: qcSet(b)?.rows || null };
}

/* ---------- live blocks (re-rendered without touching the form) ---------- */
function gridHtml(b) {
  const { pl, flags, uses } = context(b);
  if (!pl) return '<div class="empty">Choose or create an index plate to see the plate.</div>';
  const byWell = new Map(b.plate.samples.filter(s => s.well).map(s => [s.well, s]));
  let html = `<div class="plate"><span></span>${Array.from({ length: P.COLS }, (_, c) => `<span class="ph">${c + 1}</span>`).join('')}`;
  for (const r of P.ROWS) {
    html += `<span class="ph">${r}</span>`;
    for (let c = 1; c <= P.COLS; c++) {
      const w = `${r}${c}`;
      const s = byWell.get(w);
      const other = uses.get(w);
      const cls = ['well', s ? 'mine' : '', flags[w] ? 'flagged' : '', other && !s ? 'used' : ''].join(' ');
      const title = [w, s && `${s.name} (pool ${s.pool || '–'})`, flags[w] && `flagged: ${flags[w]}`, other && `used by "${other.batch}": ${other.sample}`].filter(Boolean).join(' · ');
      const style = s && s.pool ? `style="background:color-mix(in srgb, ${poolColor(s.pool)} 30%, transparent);border-color:${poolColor(s.pool)}"` : '';
      html += `<button type="button" class="${cls}" data-act="plate-flag" data-well="${w}" title="${esc(title)}" ${style}>
        <span class="wn">${w}</span><span class="ws">${s ? esc(s.name) : other ? '·' : ''}</span></button>`;
    }
  }
  const pools = [...new Set(b.plate.samples.map(s => s.pool).filter(Boolean))].sort((a, c) => a - c);
  const legend = pools.map(p => `<span class="lg"><i style="background:${poolColor(p)}"></i>pool ${p}</span>`).join('');
  return `<div class="tablewrap">${html}</div></div>
    <div class="row small muted" style="margin-top:6px">${legend}<span class="lg"><i class="sw flagged"></i>flagged well</span><span class="lg"><i class="sw used"></i>used by another batch</span></div>
    <p class="hint">Click any well to flag it (low volume, contamination…) or to clear a flag. Flags belong to the plate and carry across batches.</p>`;
}

function issuesHtml(b) {
  const { flags, uses, rows } = context(b);
  if (!b.plate.samples.length) return '';
  const issues = P.plateIssues(b.plate, flags, uses, rows);
  if (!issues.length) return '<div class="card ok">✓ No problems found: every sample has a free, unflagged well, a pool, and a measurement.</div>';
  return `<div class="card">${issues.map(i => `<div class="note ${i.level === 'bad' ? 'error' : 'deviation'}">${esc(i.text)}</div>`).join('')}</div>`;
}

function planHtml(b) {
  const rows = qcSet(b)?.rows;
  const plan = P.poolPlan(b.plate.samples, rows, { targetNg: b.plate.targetNg, availUl: b.plate.availUl });
  if (!plan.length) return '<div class="empty">Pools appear here once samples are in pools.</div>';
  return plan.map(p => {
    const lines = p.rows.map(r => `<tr><td>${esc(r.name)}</td><td>${r.well || ''}</td><td class="num">${r.conc != null ? fmt(r.conc, 1) : '–'}</td>
      <td class="num">${r.ng != null ? fmt(r.ng, 0) : ''}</td>
      <td class="num ${r.ul != null && r.ul > b.plate.availUl - 1e-9 ? 'flag' : ''}"><b>${r.ul != null ? fmt(r.ul, 2) : '–'}</b></td></tr>`).join('');
    const notes = [
      p.limitedBy ? `<p class="hint">⚠ Short of the target by ${fmt(p.shortfall, 0)} ng. <b>${esc(p.limitedBy)}</b> is the weakest: only ${b.plate.availUl} µL available at its concentration, so every library is capped at ${fmt(p.each, 0)} ng to keep the pool equal-mass.</p>` : '',
      p.missing.length ? `<p class="hint">⚠ No concentration for ${esc(p.missing.join(', '))}: add a measurement for it.</p>` : '',
    ].join('');
    return `<div class="card"><h3 style="color:${poolColor(p.pool)}">Pool ${p.pool} <span class="muted small">· ${p.k} ${p.k === 1 ? 'library' : 'libraries'}</span></h3>
      <div class="tablewrap"><table><thead><tr><th>Library</th><th>Well</th><th class="num">ng/µL</th><th class="num">ng taken</th><th class="num">µL to take</th></tr></thead><tbody>${lines}
      <tr class="total"><td colspan="3">Pool total</td><td class="num">${fmt(p.totalNg, 0)} ng</td><td class="num">${fmt(p.totalUl, 1)} µL</td></tr></tbody></table></div>${notes}</div>`;
  }).join('');
}

function refreshBlocks(b) {
  for (const [id, html] of [['plate-grid', gridHtml(b)], ['plate-issues', issuesHtml(b)], ['pool-plan', planHtml(b)]]) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }
}

/* ---------- the tab ---------- */
export function render(b, header) {
  const p = b.plate;
  const sets = b.qc.sets.map(s => `<option value="${s.id}" ${s.id === p.qcSetId ? 'selected' : ''}>${esc(s.label)} (${s.rows.length})</option>`).join('');
  const plates = Object.values(db.plates).map(x => `<option value="${x.id}" ${x.id === p.plateId ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  const f = (k, label, type, extra = '') => `<label class="field">${label}<input type="${type}" data-chg="plate-field" data-pfield="${k}" value="${esc(p[k])}" ${extra}></label>`;
  const table = p.samples.map((s, i) => `<tr><td>${esc(s.name)}</td><td>${s.well || '<span class="muted">–</span>'}</td>
    <td><select data-chg="plate-pool" data-i="${i}" aria-label="Pool for ${esc(s.name)}"><option value="">–</option>${Array.from({ length: Math.max(p.samples.length, 1) }, (_, k) => `<option ${s.pool === k + 1 ? 'selected' : ''}>${k + 1}</option>`).join('')}</select></td></tr>`).join('');
  return `${header(b, 'plate')}
  <div class="card"><h3>1. Samples</h3>
    <label class="field">One library per line, in the order you want them on the plate
      <textarea id="names" rows="7" data-pfield="names" placeholder="S01&#10;S02&#10;S03">${esc(p.samples.map(s => s.name).join('\n'))}</textarea></label>
    <div class="row" style="margin-top:8px">
      <select id="qcSource" aria-label="QC set to take names from"><option value="">QC set…</option>${sets}</select>
      <button class="btn small" data-act="plate-from-qc">Load names from QC set</button>
      <span class="muted small">or</span>
      <input type="text" id="genPrefix" value="S" style="width:4.5em" aria-label="Name prefix"><input type="number" id="genCount" value="${b.n}" min="1" max="96" style="width:5.5em" aria-label="How many">
      <button class="btn small" data-act="plate-gen">Generate names</button></div></div>
  <div class="card"><h3>2. Index plate</h3>
    <div class="grid">
      <label class="field">UDI plate<select data-chg="plate-field" data-pfield="plateId"><option value="">– choose –</option>${plates}</select></label>
      <label class="field">New plate name<span class="row" style="flex-wrap:nowrap"><input type="text" id="newPlateName" placeholder="e.g. UDI set A, lot 1234"><button class="btn small" data-act="plate-new">Add</button></span></label>
      ${f('start', 'Start at well', 'text', 'maxlength="3" style="text-transform:uppercase"')}
      <label class="field">Fill order<select data-chg="plate-field" data-pfield="order"><option value="row" ${p.order === 'row' ? 'selected' : ''}>Row-wise (A1, A2 … A12, B1 …)</option><option value="col" ${p.order === 'col' ? 'selected' : ''}>Column-wise (A1, B1 … H1, A2 …)</option></select></label>
    </div>
    <div class="row" style="margin-top:10px">
      <label class="row"><input type="checkbox" data-chg="plate-field" data-pfield="skipFlagged" ${p.skipFlagged ? 'checked' : ''}> skip flagged wells</label>
      <label class="row"><input type="checkbox" data-chg="plate-field" data-pfield="skipUsed" ${p.skipUsed ? 'checked' : ''}> skip wells other batches used</label>
      <button class="btn primary" data-act="plate-assign">Assign wells</button></div>
    <p class="hint">Assigning replaces every well in this batch. It does not move wells while you edit flags or other batches, so a plate map never changes under you.</p></div>
  <div class="card"><h3>3. Hyb pools</h3>
    <div class="grid">${f('plex', 'Libraries per hyb (plex)', 'number', 'min="1" max="96"')}${f('targetNg', 'Target ng per hyb', 'number', 'min="1"')}${f('availUl', 'Library volume available (µL)', 'number', 'min="1" step="0.5"')}
      <label class="field">Concentrations from<select data-chg="plate-field" data-pfield="qcSetId"><option value="">– QC set –</option>${sets}</select></label></div>
    <div class="row" style="margin-top:10px"><button class="btn" data-act="plate-autopool">Group consecutive libraries into pools</button></div></div>
  <h2>Plate</h2><div id="plate-grid">${gridHtml(b)}</div>
  <div id="plate-issues" style="margin-top:10px">${issuesHtml(b)}</div>
  <h2>Pooling plan <span class="muted small" style="text-transform:none;letter-spacing:0">equal mass per library</span></h2><div id="pool-plan">${planHtml(b)}</div>
  ${p.samples.length ? `<h2>Samples</h2><div class="card"><div class="tablewrap"><table><thead><tr><th>Library</th><th>Well</th><th>Pool</th></tr></thead><tbody>${table}</tbody></table></div></div>
  <p><button class="btn" data-act="plate-csv">Download plate map (CSV)</button> <span class="muted small">Index sequences are kit-specific and not included.</span></p>` : ''}`;
}

/* ---------- reading the form back into the batch (no re-render) ---------- */
function parseNames(text) {
  return text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

function setNames(b, names) {
  const old = new Map(b.plate.samples.map(s => [key(s.name), s]));
  const pools = P.autoPool(names.length, b.plate.plex);
  b.plate.samples = names.map((name, i) => {
    const prev = old.get(key(name));
    return { name, well: prev?.well ?? null, pool: prev ? prev.pool : pools[i] };
  });
}

function readForm(b) {
  const el = root();
  for (const input of el.querySelectorAll('[data-pfield]')) {
    const k = input.dataset.pfield;
    if (k === 'names') continue;
    if (input.type === 'checkbox') b.plate[k] = input.checked;
    else if (input.type === 'number') b.plate[k] = Number(input.value) || 0;
    else if (k === 'plateId' || k === 'qcSetId') b.plate[k] = input.value || null;
    else if (k === 'start') b.plate.start = P.parseWell(input.value) || input.value.toUpperCase();
    else b.plate[k] = input.value;
  }
  const ta = el.querySelector('#names');
  if (ta) {
    const names = parseNames(ta.value);
    if (names.join('\n') !== b.plate.samples.map(s => s.name).join('\n')) setNames(b, names);
  }
}

/* ---------- actions ---------- */
export const clicks = {
  'plate-flag': (el, b) => {
    const pl = plateOf(b);
    if (!pl) { alert('Choose or create an index plate first.'); return 'none'; }
    const w = el.dataset.well;
    if (pl.flags[w]) {
      if (confirm(`${w} is flagged: "${pl.flags[w]}". Clear the flag?`)) delete pl.flags[w];
    } else {
      const reason = prompt(`Flag well ${w}. Why? (e.g. low volume)`);
      if (reason && reason.trim()) pl.flags[w] = reason.trim();
    }
  },
  'plate-new': (el, b) => {
    const name = root().querySelector('#newPlateName').value.trim();
    if (!name) { alert('Give the plate a name.'); return 'none'; }
    readForm(b);
    const id = newId('p');
    db.plates[id] = { id, name, flags: {} };
    b.plate.plateId = id;
  },
  'plate-from-qc': (el, b) => {
    readForm(b);
    const id = root().querySelector('#qcSource').value;
    const set = b.qc.sets.find(s => s.id === id);
    if (!set) { alert('Pick a QC set first (add one on the QC tab).'); return 'none'; }
    setNames(b, set.rows.map(r => r.name));
    b.plate.qcSetId = set.id;
  },
  'plate-gen': (el, b) => {
    readForm(b);
    const prefix = root().querySelector('#genPrefix').value;
    const n = Math.min(96, Math.max(1, Number(root().querySelector('#genCount').value) || 0));
    const width = String(n).length;
    setNames(b, Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(Math.max(2, width), '0')}`));
  },
  'plate-assign': (el, b) => {
    readForm(b);
    const pl = plateOf(b);
    if (!pl) { alert('Choose or create an index plate first.'); return 'none'; }
    if (!P.parseWell(b.plate.start)) { alert('Start well must look like A1 to H12.'); return 'none'; }
    const left = P.assignWells(b.plate, pl.flags, P.plateUses(db.batches, pl.id, b.id));
    if (left) alert(`${left} sample(s) do not fit on the plate after skipping blocked wells.`);
  },
  'plate-autopool': (el, b) => {
    readForm(b);
    const pools = P.autoPool(b.plate.samples.length, b.plate.plex);
    b.plate.samples.forEach((s, i) => { s.pool = pools[i]; });
  },
  'plate-csv': (el, b) => {
    readForm(b);
    const plan = P.poolPlan(b.plate.samples, qcSet(b)?.rows, { targetNg: b.plate.targetNg, availUl: b.plate.availUl });
    download(`${b.name.replace(/\W+/g, '_')}_plate_map.csv`, P.plateMapCsv(plateOf(b)?.name, b.plate.samples, plan), 'text/csv');
    return 'none';
  },
};

export const changes = {
  // Edits that only affect the live blocks: save, refresh the blocks, leave the form alone.
  'plate-field': (el, b) => { readForm(b); refreshBlocks(b); return 'none'; },
  'plate-pool': (el, b) => {
    b.plate.samples[Number(el.dataset.i)].pool = Number(el.value) || null;
    refreshBlocks(b);
    return 'none';
  },
};
