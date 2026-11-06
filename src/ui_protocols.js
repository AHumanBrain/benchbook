import { flattenProtocol } from './calc.js';
import { renderItem } from './render.js';
import {
  STEP_TYPES, TYPE_LABEL, FIELDS, ROW_FIELDS, getPath, setPath, clone, makeDefault, parseDuration, durationText,
  blankProtocol, duplicateProtocol, validateProtocol, normalizeProtocol,
} from './protocol_edit.js';
import { db, persist, esc, download } from './shared.js';

let builtins = {};                 // id -> shipped protocol (read-only)
let draft = null;                  // { id, p, dirty, errors, flash } the protocol being edited
export const setBuiltins = list => { builtins = Object.fromEntries(list.map(p => [p.id, p])); };
export const takenIds = () => new Set([...Object.keys(builtins), ...Object.keys(db.protocols)]);
const sourceOf = id => db.protocols[id] || builtins[id];

window.addEventListener('beforeunload', e => { if (draft?.dirty) { e.preventDefault(); e.returnValue = ''; } });

/* ---------- list ---------- */
function count(p) {
  const steps = p.sections.reduce((n, s) => n + s.steps.length, 0);
  return `${p.sections.length} sections, ${steps} steps`;
}

export function renderList() {
  document.body.className = 'bench';
  const card = (p, custom) => `<div class="card"><div class="row spread"><div>
      <h3>${esc(p.name)} ${custom ? `<span class="chip">custom · rev ${p.revision || 1}</span>` : '<span class="chip">built in</span>'}</h3>
      <div class="muted small">${count(p)} · ${esc(p.unit_label)}${p.based_on ? ` · based on ${esc(builtins[p.based_on]?.name || p.based_on)}` : ''}</div>
      ${p.description ? `<p class="hint">${esc(p.description)}</p>` : ''}</div>
    <div class="row">${custom ? `<a class="btn small primary" href="#/protocol/${p.id}">Edit</a>` : ''}
      <button class="btn small" data-act="pe-dup-proto" data-id="${p.id}">${custom ? 'Duplicate' : 'Copy to edit'}</button>
      <button class="btn small" data-act="pe-export" data-id="${p.id}">Export</button>
      ${custom ? `<button class="btn small danger" data-act="pe-delete" data-id="${p.id}">Delete</button>` : ''}</div></div></div>`;
  const custom = Object.values(db.protocols).sort((a, b) => a.name.localeCompare(b.name));
  return `<h1>Protocols</h1>
  <p class="muted">Built-in protocols are read-only. Copy one to change volumes, timings or steps. Batches you already started keep the version they started with.</p>
  <div class="row"><button class="btn primary" data-act="pe-new">New blank protocol</button>
    <label class="btn">Import protocol file<input type="file" accept="application/json,.json" data-chg="pe-import" hidden></label></div>
  <h2>Yours</h2>${custom.length ? custom.map(p => card(p, true)).join('') : '<div class="empty">No custom protocols yet. Copy a built-in one to start.</div>'}
  <h2>Built in</h2>${Object.values(builtins).map(p => card(p, false)).join('')}`;
}

/* ---------- editor fields ---------- */
const attr = (path, kind) => `data-chg="pe" data-ep="${esc(path)}" data-kind="${kind}"`;

function input(path, kind, value, ph = '', extra = '') {
  const v = value ?? '';
  if (kind === 'area') return `<textarea rows="2" ${attr(path, kind)} placeholder="${esc(ph)}" ${extra}>${esc(v)}</textarea>`;
  if (kind === 'num' || kind === 'numreq') return `<input type="number" step="any" ${attr(path, kind)} value="${esc(v)}" placeholder="${esc(ph)}" ${extra}>`;
  if (kind === 'dur') return `<input type="text" ${attr(path, kind)} value="${esc(durationText(value))}" placeholder="${esc(ph)}" ${extra}>`;
  return `<input type="text" ${attr(path, kind)} value="${esc(v)}" placeholder="${esc(ph)}" ${extra}>`;
}

function field(base, f, step) {
  const path = `${base}.${f.path}`;
  const value = getPath(step, f.path);
  if (f.kind === 'noDispense') {
    return `<label class="row" style="grid-column:1/-1"><input type="checkbox" ${attr(path, 'noDispense')} ${value === false ? 'checked' : ''}> ${esc(f.label)}</label>`;
  }
  const wide = f.kind === 'area' || f.path === 'title' || f.path === 'text' || f.path === 'note' || f.path === 'wash';
  return `<label class="field" ${wide ? 'style="grid-column:1/-1"' : ''}>${esc(f.label)}${input(path, f.kind, value, f.ph)}</label>`;
}

const del = (path, i, label = 'Remove') => `<button type="button" class="btn small danger" data-act="pe-del" data-path="${path}" data-i="${i}" aria-label="${label}">✕</button>`;

function rows(path, kind, list, addLabel, addKind) {
  const spec = ROW_FIELDS[kind];
  const body = (list || []).map((r, i) => {
    if (r.cycles !== undefined) {
      return `<div class="cyclebox"><div class="row"><b>Repeat</b>${input(`${path}.${i}.cycles`, 'numreq', r.cycles, '', 'style="width:5em" min="1" step="1"')}<b>times</b>
        <span style="flex:1"></span>${del(path, i, 'Remove cycle')}</div>${rows(`${path}.${i}.steps`, 'prow', r.steps, 'Add temperature step to cycle', 'prow')}</div>`;
    }
    return `<div class="prow ${kind}">${spec.map(f => input(`${path}.${i}.${f.k}`, f.kind, r[f.k], f.ph)).join('')}${del(path, i)}</div>`;
  }).join('');
  return `<div class="plist">${body}<div class="row"><button type="button" class="btn small" data-act="pe-add" data-path="${path}" data-kind="${addKind}">＋ ${addLabel}</button>
    ${path.endsWith('.program') ? `<button type="button" class="btn small" data-act="pe-add" data-path="${path}" data-kind="pcycle">＋ Repeat group (cycles)</button>` : ''}</div></div>`;
}

function stepCard(si, ti, step) {
  const base = `sections.${si}.steps.${ti}`;
  const sp = `sections.${si}.steps`;
  let extra = '';
  if (step.type === 'mix') {
    extra = `<h4>Master-mixed components <span class="muted small">(overage applied)</span></h4>${rows(`${base}.components`, 'component', step.components, 'Add component', 'component')}
      <h4>Added to each reaction separately <span class="muted small">(no overage)</span></h4>${rows(`${base}.add`, 'component', step.add, 'Add per-reaction item', 'addition')}`;
  } else if (step.type === 'thermocycle') {
    extra = `<h4>Program <span class="muted small">(time like 30 s, 10 min, 1 h, or hold)</span></h4>${rows(`${base}.program`, 'prow', step.program, 'Add temperature step', 'prow')}`;
  }
  return `<div class="card pstep"><div class="row spread"><span class="chip">${esc(TYPE_LABEL[step.type] || step.type)}</span>
    <span class="row"><button type="button" class="btn small" data-act="pe-move" data-path="${sp}" data-i="${ti}" data-dir="-1" aria-label="Move up">↑</button>
      <button type="button" class="btn small" data-act="pe-move" data-path="${sp}" data-i="${ti}" data-dir="1" aria-label="Move down">↓</button>
      <button type="button" class="btn small" data-act="pe-dup" data-path="${sp}" data-i="${ti}">Duplicate</button>${del(sp, ti, 'Delete step')}</span></div>
    <div class="grid" style="margin-top:8px">${(FIELDS[step.type] || []).map(f => field(base, f, step)).join('')}</div>${extra}</div>`;
}

function sectionCard(si, sec, count) {
  return `<div class="card psection"><div class="row spread">
      <label class="field" style="flex:1">Section title${input(`sections.${si}.title`, 'text', sec.title)}</label>
      <span class="row"><button type="button" class="btn small" data-act="pe-move" data-path="sections" data-i="${si}" data-dir="-1" aria-label="Move section up">↑</button>
        <button type="button" class="btn small" data-act="pe-move" data-path="sections" data-i="${si}" data-dir="1" aria-label="Move section down">↓</button>
        ${del('sections', si, 'Delete section')}</span></div>
    ${sec.steps.map((st, ti) => stepCard(si, ti, st)).join('')}
    <div class="row"><select id="addtype-${si}" aria-label="Step type">${STEP_TYPES.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>
      <button type="button" class="btn small" data-act="pe-add" data-path="sections.${si}.steps" data-kind="step-from-select" data-select="addtype-${si}">＋ Add step</button></div></div>`;
}

function previewHtml() {
  try {
    const protocol = normalizeProtocol(draft.p);
    const b = { n: 24, overagePct: protocol.default_overage_pct || 10, protocol, state: {} };
    const items = flattenProtocol(protocol);
    let html = '', last = -1;
    for (const it of items) {
      if (it.si !== last) { html += `<div class="section-title" style="position:static">${esc(protocol.sections[it.si].title)}</div>`; last = it.si; }
      html += `<ol style="list-style:none;margin:0;padding:0">${renderItem(b, it)}</ol>`;
    }
    return html || '<div class="empty">Nothing to preview yet.</div>';
  } catch (e) { return `<div class="note error">Preview unavailable until the fields are filled in (${esc(e.message)}).</div>`; }
}

function statusHtml() {
  if (draft.flash) return `<span class="chip">${esc(draft.flash)}</span>`;
  return draft.dirty ? '<span class="chip warn">Unsaved changes</span>' : '<span class="muted small">All changes saved</span>';
}

export function renderEditor(id) {
  document.body.className = 'bench';
  if (!draft || draft.id !== id) draft = { id, p: clone(db.protocols[id]), dirty: false, errors: [], flash: '' };
  const p = draft.p;
  const errors = draft.errors.length ? `<div class="card"><b>Fix these before saving:</b>${draft.errors.map(e => `<div class="note error">${esc(e)}</div>`).join('')}</div>` : '';
  return `<div class="row spread"><div><a href="#/protocols">← Protocols</a><h1>${esc(p.name || 'Untitled')} <span class="chip">rev ${p.revision || 1}</span></h1></div></div>
  ${errors}
  <div class="card"><h3>Protocol</h3><div class="grid">
    <label class="field">Name${input('name', 'text', p.name)}</label>
    <label class="field">What you count (reactions, hybridizations…)${input('unit_label', 'text', p.unit_label)}</label>
    <label class="field">Default master-mix overage %${input('default_overage_pct', 'numreq', p.default_overage_pct, '', 'min="0" max="50"')}</label>
    <label class="field" style="grid-column:1/-1">Description${input('description', 'area', p.description)}</label></div>
    <p class="hint">${p.based_on ? `Based on ${esc(builtins[p.based_on]?.name || p.based_on)}. ` : ''}Each save raises the revision. New batches use the latest revision; existing batches keep theirs.</p></div>
  ${p.sections.map((s, si) => sectionCard(si, s, p.sections.length)).join('')}
  <button type="button" class="btn" data-act="pe-add" data-path="sections" data-kind="section">＋ Add section</button>
  <h2>Preview <span class="muted small" style="text-transform:none;letter-spacing:0">24 reactions, as it will look in a batch</span></h2>
  <div class="planmode" id="pe-preview">${previewHtml()}</div>
  <div class="savebar"><span id="pe-status">${statusHtml()}</span><span class="row">
    <button class="btn" data-act="pe-revert">Revert changes</button><button class="btn primary" data-act="pe-save">Save protocol</button></span></div>`;
}

const refresh = () => {
  const prev = document.getElementById('pe-preview');
  if (prev) prev.innerHTML = previewHtml();
  const st = document.getElementById('pe-status');
  if (st) st.innerHTML = statusHtml();
};

/* ---------- actions ---------- */
const arr = path => getPath(draft.p, path);
const touch = () => { draft.dirty = true; draft.flash = ''; };

function newCustom(p) {
  db.protocols[p.id] = p;
  persist();
  location.hash = `#/protocol/${p.id}`;
}

export const clicks = {
  'pe-new': () => { newCustom(blankProtocol(takenIds())); return 'none'; },
  'pe-dup-proto': el => { newCustom(duplicateProtocol(sourceOf(el.dataset.id), takenIds())); return 'none'; },
  'pe-export': el => {
    const p = sourceOf(el.dataset.id);
    download(`${p.id}.json`, JSON.stringify(normalizeProtocol(p), null, 2));
    return 'none';
  },
  'pe-delete': el => {
    const p = db.protocols[el.dataset.id];
    if (!confirm(`Delete "${p.name}"? Batches already started from it are not affected.`)) return 'none';
    delete db.protocols[p.id];
    db.settings.deleted[p.id] = new Date().toISOString();
    if (draft?.id === p.id) draft = null;
  },
  'pe-add': el => {
    const kind = el.dataset.kind === 'step-from-select' ? document.getElementById(el.dataset.select).value : el.dataset.kind;
    arr(el.dataset.path) ?? setPath(draft.p, el.dataset.path, []);
    arr(el.dataset.path).push(makeDefault(kind));
    touch();
  },
  'pe-del': el => {
    const list = arr(el.dataset.path);
    const item = list[Number(el.dataset.i)];
    if (el.dataset.path === 'sections' && item.steps.length && !confirm(`Delete the section "${item.title}" and its ${item.steps.length} step(s)?`)) return 'none';
    list.splice(Number(el.dataset.i), 1);
    touch();
  },
  'pe-move': el => {
    const list = arr(el.dataset.path);
    const i = Number(el.dataset.i), j = i + Number(el.dataset.dir);
    if (j < 0 || j >= list.length) return 'none';
    [list[i], list[j]] = [list[j], list[i]];
    touch();
  },
  'pe-dup': el => {
    const list = arr(el.dataset.path);
    const i = Number(el.dataset.i);
    const copy = clone(list[i]);
    if (copy.title) copy.title += ' (copy)';
    list.splice(i + 1, 0, copy);
    touch();
  },
  'pe-save': () => {
    const errors = validateProtocol(draft.p);
    draft.errors = errors;
    if (errors.length) { window.scrollTo(0, 0); return; }
    const saved = normalizeProtocol(draft.p);
    saved.custom = true;
    const current = db.protocols[draft.id];
    const sameAs = JSON.stringify({ ...saved, revision: 0 }) === JSON.stringify({ ...normalizeProtocol(current), custom: true, revision: 0 });
    if (sameAs) { draft.flash = 'No changes to save'; return; }
    saved.revision = (current?.revision || 0) + 1;
    db.protocols[draft.id] = saved;
    persist();
    draft = { id: draft.id, p: clone(saved), dirty: false, errors: [], flash: `Saved as revision ${saved.revision}` };
  },
  'pe-revert': () => {
    if (draft.dirty && !confirm('Discard your unsaved changes?')) return 'none';
    draft = { id: draft.id, p: clone(db.protocols[draft.id]), dirty: false, errors: [], flash: '' };
  },
};

export const changes = {
  pe: el => {
    const { ep: path, kind } = el.dataset;
    let value;
    if (kind === 'noDispense') value = el.checked ? false : undefined;
    else if (kind === 'dur') {
      const r = parseDuration(el.value);
      el.classList.toggle('bad', !r.ok);
      el.title = r.ok ? '' : 'Use a unit: 30 s, 10 min, 1 h, or hold';
      if (!r.ok) return 'none';
      value = r.value;
      el.value = durationText(value);
    } else if (kind === 'num') value = el.value === '' ? undefined : Number(el.value);
    else if (kind === 'numreq') value = el.value === '' ? null : Number(el.value);
    else value = el.value;
    setPath(draft.p, path, value);
    touch();
    refresh();
    return 'none';
  },
  'pe-import': async el => {
    const file = el.files[0];
    if (!file) return 'none';
    try {
      const p = JSON.parse(await file.text());
      const errs = validateProtocol(p);
      if (errs.length) { alert(`That protocol has problems:\n\n${errs.slice(0, 8).join('\n')}${errs.length > 8 ? '\n…' : ''}`); return 'none'; }
      const ids = takenIds();
      const imported = { ...normalizeProtocol(p), custom: true, revision: 1 };
      if (ids.has(imported.id)) imported.id = duplicateProtocol(imported, ids).id;
      newCustom(imported);
    } catch (e) { alert(`Could not import: ${e.message}`); }
    el.value = '';
    return 'none';
  },
};

export const editorOpen = () => draft;
