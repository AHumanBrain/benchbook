import { flattenProtocol, newBatch, progress, collectNotes, NOTE_TAGS } from './calc.js';
import { renderItem, timerSeconds } from './render.js';

import { db, persist, ensureBatch, esc, clock, download } from './shared.js';
import * as qcUI from './ui_qc.js';
import * as plateUI from './ui_plate.js';
import * as protoUI from './ui_protocols.js';
import * as backupUI from './ui_backup.js';
import * as compareUI from './ui_compare.js';
import * as overviewUI from './ui_overview.js';
import * as folder from './folder.js';
import { applySeed } from './seed.js';

const $app = document.getElementById('app');
const $nav = document.getElementById('topnav');

/* ---------- helpers ---------- */
const protocolCache = {};
async function loadBuiltin(id) {
  if (!protocolCache[id]) protocolCache[id] = await (await fetch(`protocols/${id}.json`)).json();
  return protocolCache[id];
}
async function builtins() {
  const ids = JSON.parse(await (await fetch('protocols/index.json')).text());
  return Promise.all(ids.map(loadBuiltin));
}
async function loadProtocol(id) {
  return db.protocols[id] || loadBuiltin(id);
}
const batchOf = id => db.batches[id];
const stateOf = (b, key) => (b.state[key] ??= { done: null, timer: null, notes: [] });


/* ---------- views ---------- */
function header(b, tab) {
  const items = flattenProtocol(b.protocol);
  const p = progress(b, items);
  const pct = p.total ? Math.round((100 * p.done) / p.total) : 0;
  const tabs = [['bench', 'Bench'], ['plan', 'Plan'], ['notes', `Notes (${collectNotes(b, items).length})`], ['qc', 'QC'], ['plate', 'Plate & pools'], ['graphs', 'Graphs'], ['info', 'Batch info']]
    .map(([id, label]) => `<a class="tab" href="#/b/${b.id}/${id}" ${id === tab ? 'aria-current="page"' : ''}>${label}</a>`).join('');
  return `<h1>${esc(b.name)}</h1>
    <div class="muted small">${esc(b.protocol.name)}${b.protocol.revision ? ` (rev ${b.protocol.revision})` : ''} · ${b.n} ${esc(b.protocol.unit_label)} · overage ${b.overagePct}%</div>
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
  const protos = [...await builtins(), ...Object.values(db.protocols).sort((x, y) => x.name.localeCompare(y.name))];
  const batches = Object.values(db.batches).sort((a, c) => c.created.localeCompare(a.created));
  const list = batches.length
    ? batches.map(b => {
      const p = progress(b, flattenProtocol(b.protocol));
      return `<div class="card"><div><a class="title" href="#/b/${b.id}/bench">${esc(b.name)}</a>
        <div class="muted small">${esc(b.protocol.name)}${b.protocol.revision ? ` rev ${b.protocol.revision}` : ''} · ${b.n} ${esc(b.protocol.unit_label)} · ${p.done}/${p.total} steps · ${clock(b.created)}${b.seed ? ' · <span class="chip">from workbook</span>' : ''}</div></div>
        <a class="btn small" href="#/b/${b.id}/bench">Open</a></div>`;
    }).join('')
    : '<div class="empty">No batches yet. Start one below.</div>';
  const st = backupUI.status();
  const nag = st.level === 'warn' || st.level === 'bad' ? `<a class="card nag" href="#/backup"><b>${esc(st.text)}.</b> Your batches exist only in this browser. <u>Set up a backup</u></a>` : '';
  return `${nag}<h1>Your batches</h1><div class="batchlist">${list}</div>
  <h2>New batch</h2>
  <form class="card" data-act="new-batch"><div class="grid">
    <label class="field">Protocol<select name="protocol" data-chg="np-proto">${protos.map(p => `<option value="${p.id}" data-ov="${p.default_overage_pct ?? 10}">${esc(p.name)}${p.custom ? ' (custom)' : ''}</option>`).join('')}</select></label>
    <label class="field">Batch name<input type="text" name="name" placeholder="e.g. batch 7" required></label>
    <label class="field">Reactions<input type="number" name="n" min="1" max="384" value="24" required></label>
    <label class="field">Master-mix overage %<input type="number" name="overage" min="0" max="50" value="${protos[0]?.default_overage_pct ?? 10}" required></label>
  </div><div class="row" style="margin-top:12px"><button class="btn primary">Start batch</button></div></form>
  <h2>Other</h2>
  <div class="row"><button class="btn" data-act="restore-seed">Restore workbook batches</button>
    <label class="btn">Import batch JSON<input type="file" accept="application/json" data-act="import" hidden></label></div>
  <p class="muted small" style="margin-top:18px">Everything stays in this browser (localStorage). Nothing is uploaded anywhere. <a href="#/backup">Back it up</a>.</p>`;
}

/* ---------- theme ---------- */
const THEME_KEY = 'benchbook.theme';
const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
const currentTheme = () => document.documentElement.dataset.theme || (systemDark() ? 'dark' : 'light');
function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch { /* the choice just lasts until the page closes */ }
  updateNav();
}
$nav.addEventListener('click', e => { if (e.target.closest('[data-act=theme]')) toggleTheme(); });
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!document.documentElement.dataset.theme) updateNav(); });

/* ---------- nav ---------- */
function updateNav(parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)) {
  const inBatch = parts[0] === 'b' && batchOf(parts[1]);
  const cur = inBatch || !parts.length ? 'batches' : parts[0] === 'protocol' ? 'protocols' : parts[0];
  const link = (id, href, label) => `<a class="btn small ${cur === id ? 'on' : ''}" href="${href}">${label}</a>`;
  $nav.innerHTML = `${backupUI.chip()}${link('batches', '#/', 'Batches')}${link('overview', '#/overview', 'Overview')}${link('compare', '#/compare', 'Compare')}${link('protocols', '#/protocols', 'Protocols')}<button class="btn small" data-act="theme" aria-label="Switch to ${currentTheme() === 'dark' ? 'light' : 'dark'} mode" title="Switch to ${currentTheme() === 'dark' ? 'light' : 'dark'} mode">${currentTheme() === 'dark' ? '☀ Light' : '☾ Dark'}</button>`;
}
folder.subscribe(() => {
  updateNav();
  if (location.hash.startsWith('#/backup')) render();
});

/* ---------- router ---------- */
async function render() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  let html;
  if (parts[0] === 'b' && batchOf(parts[1])) {
    const b = batchOf(parts[1]);
    const tab = parts[2] || 'bench';
    document.body.className = 'bench';
    html = tab === 'notes' ? viewNotes(b) : tab === 'info' ? viewInfo(b) : tab === 'qc' ? qcUI.render(b, header)
      : tab === 'plate' ? plateUI.render(b, header) : tab === 'graphs' ? overviewUI.renderGraphs(b, header) : viewProtocol(b, tab === 'plan' ? 'plan' : 'bench');
    document.title = `${b.name} · benchbook`;
  } else if (parts[0] === 'overview') {
    html = overviewUI.renderOverview();
    document.title = 'Overview · benchbook';
  } else if (parts[0] === 'compare') {
    html = compareUI.renderCompare(parts[1], parts[2]);
    document.title = 'Compare · benchbook';
  } else if (parts[0] === 'protocols') {
    protoUI.setBuiltins(await builtins());
    html = protoUI.renderList();
    document.title = 'Protocols · benchbook';
  } else if (parts[0] === 'protocol' && db.protocols[parts[1]]) {
    protoUI.setBuiltins(await builtins());
    html = protoUI.renderEditor(parts[1]);
    document.title = 'Edit protocol · benchbook';
  } else if (parts[0] === 'backup') {
    html = backupUI.render();
    document.title = 'Backup · benchbook';
  } else {
    html = await viewHome();
    document.title = 'benchbook';
  }
  updateNav(parts);
  const y = window.scrollY;
  $app.innerHTML = html;
  window.scrollTo(0, y);
}
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });

/* ---------- actions ---------- */
const currentBatch = () => (location.hash.startsWith('#/b/') ? batchOf(location.hash.split('/')[2]) : undefined);

$app.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const b = currentBatch();
  const global = protoUI.clicks[act] || backupUI.clicks[act];
  if (global) { const r = await global(el, b, e); persist(); if (r !== 'none') render(); return; }
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
    delete db.batches[b.id]; db.settings.deleted[b.id] = new Date().toISOString(); persist(); location.hash = '#/'; return;
  } else if (act === 'copy-notes' && b) {
    const text = collectNotes(b, flattenProtocol(b.protocol)).map(n => `[${n.tag}] ${n.step}: ${n.text}`).join('\n');
    try { await navigator.clipboard.writeText(text); el.textContent = 'Copied'; } catch { download('notes.txt', text, 'text/plain'); }
    return;
  } else if (act === 'restore-seed') {
    const seed = await (await fetch('data/seed.json')).json();
    const n = applySeed(db, seed, { force: true, ensure: ensureBatch });
    persist();
    alert(n ? `Restored ${n} batch(es) from the lab workbook data.` : 'Every batch from the lab workbook is already here.');
    render(); return;
  } else return;
  persist(); render();
});

$app.addEventListener('change', async e => {
  const el = e.target;
  const b = currentBatch();
  const global = protoUI.changes[el.dataset.chg] || backupUI.changes[el.dataset.chg] || compareUI.changes[el.dataset.chg] || overviewUI.changes[el.dataset.chg];
  if (global) { const r = await global(el, b, e); persist(); if (r !== 'none') render(); return; }
  if (el.dataset.chg === 'np-proto') {
    const ov = el.selectedOptions[0]?.dataset.ov;
    const f = el.form?.querySelector('[name=overage]');
    if (f && ov !== undefined) f.value = ov;
    return;
  }
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
window.benchbook = { get db() { return db; }, persist };
folder.init().then(() => updateNav());
(async () => {
  try {
    const res = await fetch('data/seed.json');
    if (res.ok && applySeed(db, await res.json(), { ensure: ensureBatch })) persist();
  } catch { /* offline or no seed file: the app works without it */ }
  render();
})();
