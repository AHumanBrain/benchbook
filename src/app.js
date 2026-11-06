import {
  fmt, fmtDuration, mixTable, programSeconds, flattenProtocol, newBatch, progress, collectNotes, NOTE_TAGS,
} from './calc.js';

import { db, persist, ensureBatch, esc, clock, download } from './shared.js';
import * as qcUI from './ui_qc.js';
import * as plateUI from './ui_plate.js';

const $app = document.getElementById('app');
const $nav = document.getElementById('topnav');

/* ---------- helpers ---------- */
const protocolCache = {};
async function loadProtocol(id) {
  if (!protocolCache[id]) protocolCache[id] = await (await fetch(`protocols/${id}.json`)).json();
  return protocolCache[id];
}
const batchOf = id => db.batches[id];
const stateOf = (b, key) => (b.state[key] ??= { done: null, timer: null, notes: [] });

/* ---------- timers ---------- */
const beeped = new Set();
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.25, 0.5].forEach(t => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.value = 880; g.gain.value = 0.15; o.connect(g); g.connect(ctx.destination);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.15);
    });
  } catch { /* no audio available */ }
}
function timerText(endIso, key) {
  const left = Math.round((new Date(endIso) - Date.now()) / 1000);
  if (left <= 0) {
    if (!beeped.has(key + endIso)) { beeped.add(key + endIso); beep(); }
    return { text: 'done', cls: 'finished' };
  }
  const h = Math.floor(left / 3600), m = Math.floor((left % 3600) / 60), s = left % 60;
  return { text: `${h ? h + ':' + String(m).padStart(2, '0') : m}:${String(s).padStart(2, '0')}`, cls: 'running' };
}
setInterval(() => {
  document.querySelectorAll('.timer[data-end]').forEach(el => {
    const { text, cls } = timerText(el.dataset.end, el.dataset.key);
    el.className = `timer ${cls}`;
    el.querySelector('.clock').textContent = text;
  });
}, 1000);

/* ---------- rendering pieces ---------- */
function renderMix(step, b) {
  const t = mixTable(step, b.n, b.overagePct);
  const rows = t.mmRows.map(r => `<tr><td>${esc(r.name)}</td><td class="num">${fmt(r.perRxn)}</td><td class="num"><b>${fmt(r.total, 1)}</b></td></tr>`).join('');
  const adds = t.addRows.map(r => `<tr><td>${esc(r.name)} <span class="muted small">(add per reaction)</span></td><td class="num">${fmt(r.perRxn)}</td><td class="num">${fmt(r.total, 1)}</td></tr>`).join('');
  const input = step.input
    ? `<tr><td>${esc(step.input.name)} <span class="muted small">${step.input.note ? esc(step.input.note) : '(sample)'}</span></td><td class="num">${step.input.vol != null ? fmt(step.input.vol) : '–'}</td><td class="num">${step.input.vol != null ? fmt(step.input.vol * b.n) : ''}</td></tr>`
    : '';
  const dispense = t.dispense != null
    ? `<tr class="total"><td>Master mix, dispense per reaction</td><td class="num">${fmt(t.dispense)}</td><td class="num">${fmt(t.mmTotal, 1)} mixed</td></tr>`
    : t.mmRows.length ? `<tr class="total"><td>Total volume to prepare</td><td class="num">${fmt(t.mmPerRxn)}</td><td class="num">${fmt(t.mmTotal, 1)}</td></tr>` : '';
  const final = t.finalVol ? `<p class="hint">Final reaction volume: ${fmt(t.finalVol)} µL</p>` : '';
  return `<h3>${esc(step.title)}</h3>
  <div class="tablewrap"><table><thead><tr><th>Component</th><th class="num">µL / rxn</th><th class="num">µL for ${b.n} (+${b.overagePct}%)</th></tr></thead>
  <tbody>${input}${rows}${dispense}${adds}</tbody></table></div>${final}`;
}

function renderProgramRows(program, indent = false) {
  return program.map(item => {
    if (item.cycles) {
      return `<tr class="cycle"><td colspan="3"><b>${item.cycles}×</b> cycle</td></tr>${renderProgramRows(item.steps, true)}`;
    }
    return `<tr><td class="${indent ? 'indent' : ''}">${esc(item.name)}</td><td class="num">${item.temp_c} °C</td><td class="num">${fmtDuration(item.duration_s)}</td></tr>`;
  }).join('');
}

function renderThermo(step) {
  const total = programSeconds(step.program);
  return `<h3>${esc(step.title)}</h3>
  <div class="tablewrap"><table><thead><tr><th>Step</th><th class="num">Temp</th><th class="num">Time</th></tr></thead><tbody>${renderProgramRows(step.program)}</tbody></table></div>
  <div class="chips">${total ? `<span class="chip">runs ≈ ${fmtDuration(total)}</span>` : ''}${step.lid_c ? `<span class="chip">lid ${step.lid_c} °C</span>` : ''}</div>`;
}

function renderPlain(step, n) {
  const vol = step.per_rxn_vol != null
    ? `<div class="chips"><span class="chip">${fmt(step.per_rxn_vol)} µL / rxn</span><span class="chip">${fmt(step.per_rxn_vol * n, 1)} µL for ${n}${step.per_label ? ' ' + esc(step.per_label) : ''}</span></div>`
    : '';
  return `<div class="text">${esc(step.text)}</div>${vol}`;
}

function timerSeconds(step) {
  if (step.timer_min) return step.timer_min * 60;
  if (step.type === 'thermocycle') return programSeconds(step.program) || null;
  return null;
}

function renderTimer(it, st) {
  const secs = timerSeconds(it.step);
  if (!secs) return '';
  if (st.timer) {
    const { text, cls } = timerText(st.timer, it.key);
    return `<span class="timer ${cls}" data-key="${it.key}" data-end="${st.timer}"><span class="clock">${text}</span>
      <button class="btn small" data-act="timer-stop" data-key="${it.key}">Stop</button></span>`;
  }
  return `<span class="timer"><button class="btn small" data-act="timer-start" data-key="${it.key}">⏱ Start ${fmtDuration(secs)}</button></span>`;
}

function renderNotes(b, it, st) {
  const list = (st.notes || []).map((n, i) => `<div class="note ${esc(n.tag)}"><span class="tag">${esc(n.tag)}</span>${esc(n.text)}<span class="when">${clock(n.t)}</span>
    <button class="btn small bench-only" data-act="note-del" data-key="${it.key}" data-i="${i}" aria-label="Delete note">×</button></div>`).join('');
  return `<div class="notes">${list}</div>
  <details class="addnote bench-only"><summary>＋ add note</summary>
    <form data-act="note-add" data-key="${it.key}">
      <input type="text" name="text" placeholder="What happened?" required autocomplete="off">
      <select name="tag" aria-label="Note type">${NOTE_TAGS.map(t => `<option>${t}</option>`).join('')}</select>
      <button class="btn small primary">Save</button>
    </form></details>`;
}

function renderItem(b, it) {
  const st = b.state[it.key] || {};
  const s = it.step;
  const body = s.type === 'mix' ? renderMix(s, b) : s.type === 'thermocycle' ? renderThermo(s) : renderPlain(s, b.n);
  const note = s.note ? `<p class="hint">${esc(s.note)}</p>` : '';
  return `<li class="item ${st.done ? 'done' : ''}" id="item-${it.key}">
    <input class="check" type="checkbox" data-act="toggle" data-key="${it.key}" ${st.done ? 'checked' : ''} aria-label="Mark step done">
    <div class="body">
      ${it.heading ? `<div class="heading">${esc(it.heading)}</div>` : ''}
      ${body}${note}
      <div class="row bench-only">${renderTimer(it, st)}${st.done ? `<span class="muted small">done ${clock(st.done)}</span>` : ''}</div>
      ${renderNotes(b, it, st)}
    </div></li>`;
}

/* ---------- views ---------- */
function header(b, tab) {
  const items = flattenProtocol(b.protocol);
  const p = progress(b, items);
  const pct = p.total ? Math.round((100 * p.done) / p.total) : 0;
  const tabs = [['bench', 'Bench'], ['plan', 'Plan'], ['notes', `Notes (${collectNotes(b, items).length})`], ['qc', 'QC'], ['plate', 'Plate & pools'], ['info', 'Batch info']]
    .map(([id, label]) => `<a class="tab" href="#/b/${b.id}/${id}" ${id === tab ? 'aria-current="page"' : ''}>${label}</a>`).join('');
  return `<h1>${esc(b.name)}</h1>
    <div class="muted small">${esc(b.protocol.name)} · ${b.n} ${esc(b.protocol.unit_label)} · overage ${b.overagePct}%</div>
    <div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>
    <div class="muted small">${p.done} of ${p.total} steps done</div>
    <nav class="tabs">${tabs}</nav>`;
}

function viewProtocol(b, tab) {
  document.body.className = tab === 'plan' ? 'plan' : 'bench';
  const items = flattenProtocol(b.protocol);
  let html = header(b, tab);
  if (tab === 'plan') {
    html += `<div class="row spread"><span class="muted small">All volumes for ${b.n} ${esc(b.protocol.unit_label)}. Print this page for a bench sheet.</span><button class="btn small" data-act="print">Print</button></div>`;
  }
  let lastSection = -1;
  let open = false;
  for (const it of items) {
    if (it.si !== lastSection) {
      if (open) html += '</ol>';
      html += `<div class="section-title">${esc(b.protocol.sections[it.si].title)}</div><ol style="list-style:none;margin:0;padding:0">`;
      lastSection = it.si; open = true;
    }
    html += renderItem(b, it);
  }
  if (open) html += '</ol>';
  return html;
}

function viewNotes(b) {
  document.body.className = 'bench';
  const items = flattenProtocol(b.protocol);
  const notes = collectNotes(b, items);
  let html = header(b, 'notes');
  if (!notes.length) return html + '<div class="empty">No notes yet. Add one from any step on the Bench tab. Deviations and errors collected here become protocol improvements.</div>';
  for (const tag of NOTE_TAGS) {
    const group = notes.filter(n => n.tag === tag);
    if (!group.length) continue;
    html += `<h2>${tag} (${group.length})</h2>` + group.map(n => `<div class="note ${tag}"><b>${esc(n.step)}</b><br>${esc(n.text)}<span class="when">${clock(n.t)}</span></div>`).join('');
  }
  return html + `<p><button class="btn small" data-act="copy-notes">Copy as text</button></p>`;
}

function viewInfo(b) {
  document.body.className = 'bench';
  const f = (k, label, type = 'text') => `<label class="field">${label}<input type="${type}" data-info="${k}" value="${esc(b.info[k])}"></label>`;
  return header(b, 'info') + `
  <div class="card"><h3>Batch</h3><div class="grid">
    <label class="field">Name<input type="text" data-field="name" value="${esc(b.name)}"></label>
    <label class="field">${esc(b.protocol.unit_label)}<input type="number" min="1" max="384" data-field="n" value="${b.n}"></label>
    <label class="field">Overage %<input type="number" min="0" max="50" step="1" data-field="overagePct" value="${b.overagePct}"></label>
  </div><p class="hint">Changing the count or overage updates every volume. Steps you have already ticked stay ticked.</p></div>
  <div class="card"><h3>Run lineage</h3><div class="timeline">
    ${f('prep', 'Library prep', 'date')}${f('hyb', 'Hyb', 'date')}${f('cap', 'Capture', 'date')}${f('seq', 'Sequencing', 'date')}
  </div><div class="grid" style="margin-top:10px">${f('thermocycler', 'Thermocycler')}${f('cohyb', 'Co-processed with')}</div></div>
  <div class="card row spread"><div><h3>Data</h3><span class="muted small">Stored only in this browser. Export to keep a file copy.</span></div>
    <div class="row"><button class="btn" data-act="export">Export JSON</button><button class="btn danger" data-act="delete">Delete batch</button></div></div>`;
}

async function viewHome() {
  document.body.className = 'bench';
  const ids = JSON.parse(await (await fetch('protocols/index.json')).text());
  const protos = await Promise.all(ids.map(loadProtocol));
  const batches = Object.values(db.batches).sort((a, c) => c.created.localeCompare(a.created));
  const list = batches.length
    ? batches.map(b => {
      const p = progress(b, flattenProtocol(b.protocol));
      return `<div class="card"><div><a class="title" href="#/b/${b.id}/bench">${esc(b.name)}</a>
        <div class="muted small">${esc(b.protocol.name)} · ${b.n} ${esc(b.protocol.unit_label)} · ${p.done}/${p.total} steps · ${clock(b.created)}</div></div>
        <a class="btn small" href="#/b/${b.id}/bench">Open</a></div>`;
    }).join('')
    : '<div class="empty">No batches yet. Start one below, or load the example to look around.</div>';
  return `<h1>Your batches</h1><div class="batchlist">${list}</div>
  <h2>New batch</h2>
  <form class="card" data-act="new-batch"><div class="grid">
    <label class="field">Protocol<select name="protocol">${protos.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>
    <label class="field">Batch name<input type="text" name="name" placeholder="e.g. batch 7" required></label>
    <label class="field">Reactions<input type="number" name="n" min="1" max="384" value="24" required></label>
    <label class="field">Master-mix overage %<input type="number" name="overage" min="0" max="50" value="10" required></label>
  </div><div class="row" style="margin-top:12px"><button class="btn primary">Start batch</button></div></form>
  <h2>Other</h2>
  <div class="row"><button class="btn" data-act="load-example">Load example batch</button>
    <label class="btn">Import batch JSON<input type="file" accept="application/json" data-act="import" hidden></label></div>
  <p class="muted small" style="margin-top:18px">Everything stays in this browser (localStorage). Nothing is uploaded anywhere.</p>`;
}

/* ---------- router ---------- */
async function render() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  let html;
  if (parts[0] === 'b' && batchOf(parts[1])) {
    const b = batchOf(parts[1]);
    const tab = parts[2] || 'bench';
    document.body.className = 'bench';
    html = tab === 'notes' ? viewNotes(b) : tab === 'info' ? viewInfo(b) : tab === 'qc' ? qcUI.render(b, header)
      : tab === 'plate' ? plateUI.render(b, header) : viewProtocol(b, tab === 'plan' ? 'plan' : 'bench');
    $nav.innerHTML = '<a class="btn small" href="#/">All batches</a>';
    document.title = `${b.name} · benchbook`;
  } else {
    html = await viewHome();
    $nav.innerHTML = '';
    document.title = 'benchbook';
  }
  const y = window.scrollY;
  $app.innerHTML = html;
  window.scrollTo(0, y);
}
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });

/* ---------- actions ---------- */
const currentBatch = () => batchOf(location.hash.split('/')[2]);

$app.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const b = currentBatch();
  const ext = qcUI.clicks[act] || plateUI.clicks[act];
  if (ext && b) { const r = await ext(el, b, e); persist(); if (r !== 'none') render(); return; }
  if (act === 'timer-start' && b) {
    const it = flattenProtocol(b.protocol).find(i => i.key === el.dataset.key);
    stateOf(b, it.key).timer = new Date(Date.now() + timerSeconds(it.step) * 1000).toISOString();
  } else if (act === 'timer-stop' && b) {
    stateOf(b, el.dataset.key).timer = null;
  } else if (act === 'note-del' && b) {
    stateOf(b, el.dataset.key).notes.splice(Number(el.dataset.i), 1);
  } else if (act === 'print') {
    window.print(); return;
  } else if (act === 'export' && b) {
    download(`${b.name.replace(/\W+/g, '_')}.benchbook.json`, JSON.stringify({ ...b, plateSnapshot: db.plates[b.plate.plateId] || null }, null, 2)); return;
  } else if (act === 'delete' && b) {
    if (!confirm(`Delete "${b.name}"? Export it first if you want a copy.`)) return;
    delete db.batches[b.id]; persist(); location.hash = '#/'; return;
  } else if (act === 'copy-notes' && b) {
    const text = collectNotes(b, flattenProtocol(b.protocol)).map(n => `[${n.tag}] ${n.step}: ${n.text}`).join('\n');
    try { await navigator.clipboard.writeText(text); el.textContent = 'Copied'; } catch { download('notes.txt', text, 'text/plain'); }
    return;
  } else if (act === 'load-example') {
    const ex = await (await fetch('examples/example_batch.json')).json();
    ex.id = `ex${Date.now().toString(36)}`; ex.created = new Date().toISOString();
    const snap = ex.plateSnapshot; delete ex.plateSnapshot;
    if (snap) { const pid = `pex${Date.now().toString(36)}`; db.plates[pid] = { ...snap, id: pid }; ex.plate.plateId = pid; }
    db.batches[ex.id] = ensureBatch(ex); persist(); location.hash = `#/b/${ex.id}/bench`; return;
  } else return;
  persist(); render();
});

$app.addEventListener('change', async e => {
  const el = e.target;
  const b = currentBatch();
  const ext = qcUI.changes[el.dataset.chg] || plateUI.changes[el.dataset.chg];
  if (ext && b) { const r = await ext(el, b, e); persist(); if (r !== 'none') render(); return; }
  if (el.dataset.act === 'toggle' && b) {
    const st = stateOf(b, el.dataset.key);
    st.done = el.checked ? new Date().toISOString() : null;
    persist(); render();
  } else if (el.dataset.info && b) {
    b.info[el.dataset.info] = el.value; persist();
  } else if (el.dataset.field && b) {
    const k = el.dataset.field;
    if (k === 'name') b.name = el.value.trim() || b.name;
    else b[k] = Math.max(k === 'n' ? 1 : 0, Number(el.value) || 0);
    persist(); render();
  } else if (el.dataset.act === 'import') {
    try {
      const imp = JSON.parse(await el.files[0].text());
      if (!imp.protocol || !imp.state) throw new Error('not a benchbook batch');
      imp.id = imp.id && !db.batches[imp.id] ? imp.id : `i${Date.now().toString(36)}`;
      const snap = imp.plateSnapshot; delete imp.plateSnapshot;
      if (snap && imp.plate?.plateId) db.plates[imp.plate.plateId] ??= snap;
      db.batches[imp.id] = ensureBatch(imp); persist(); location.hash = `#/b/${imp.id}/bench`;
    } catch (err) { alert(`Could not import: ${err.message}`); }
  }
});

$app.addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form));
  const ext = qcUI.submits[form.dataset.act];
  if (ext) { const b = currentBatch(); if (b) { const r = await ext(form, data, b); persist(); if (r !== 'none') render(); } return; }
  if (form.dataset.act === 'new-batch') {
    const protocol = await loadProtocol(data.protocol);
    const b = newBatch(protocol, { name: data.name.trim(), n: Number(data.n), overagePct: Number(data.overage) });
    db.batches[b.id] = ensureBatch(b); persist(); location.hash = `#/b/${b.id}/bench`;
  } else if (form.dataset.act === 'note-add') {
    const b = currentBatch();
    stateOf(b, form.dataset.key).notes.push({ t: new Date().toISOString(), tag: data.tag, text: data.text.trim() });
    persist(); render();
  }
});

// Small hook for tests and debugging.
window.benchbook = { get db() { return db; } };
render();
