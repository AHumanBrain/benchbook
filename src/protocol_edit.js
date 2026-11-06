// Pure helpers behind the protocol editor: defaults, field specs, validation, normalising. No DOM.

export const STEP_TYPES = [
  ['mix', 'Master mix'],
  ['thermocycle', 'Thermocycler program'],
  ['cleanup', 'Bead cleanup'],
  ['step', 'Plain step (text, optional timer)'],
];
export const TYPE_LABEL = Object.fromEntries(STEP_TYPES);

/* ---------- paths into the draft ---------- */
export const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

/** Set a value at "a.b.0.c", creating missing parent objects. `undefined` removes the key. */
export function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let parent = obj;
  for (const k of keys) parent = parent[k] ??= {};
  if (value === undefined) { if (Array.isArray(parent)) parent[last] = value; else delete parent[last]; } else parent[last] = value;
}

const clone = x => JSON.parse(JSON.stringify(x));
export { clone };

/* ---------- durations typed as "45 s", "10 min", "1 h", "hold" ---------- */
export function parseDuration(text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (['', 'hold', '∞', 'inf', 'infinity', 'forever', 'overnight'].includes(t)) return { ok: true, value: null };
  const m = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/.exec(t);
  if (!m) return { ok: false };
  const n = Number(m[1]);
  const unit = m[2][0];
  return { ok: true, value: Math.round(unit === 'h' ? n * 3600 : unit === 'm' ? n * 60 : n) };
}

export function durationText(sec) {
  if (sec === null || sec === undefined) return 'hold';
  if (sec >= 3600 && sec % 3600 === 0) return `${sec / 3600} h`;
  if (sec >= 60 && sec % 60 === 0) return `${sec / 60} min`;
  return `${sec} s`;
}

/* ---------- new things ---------- */
const DEFAULTS = {
  mix: () => ({ type: 'mix', title: 'New master mix', components: [{ name: '', vol: null }] }),
  thermocycle: () => ({ type: 'thermocycle', title: 'New program', program: [{ name: '', temp_c: 37, duration_s: 600 }] }),
  cleanup: () => ({ type: 'cleanup', title: 'Bead cleanup', sample: 'Sample', sample_vol: 50, bead: 'Beads', bead_vol: 50, bind_min: 5, wash: '200 uL 80% EtOH, 30 s, twice', dry_min: 3, elute_vol: 21, elute_min: 5, transfer_vol: 20 }),
  step: () => ({ type: 'step', text: '' }),
  section: () => ({ title: 'New section', steps: [] }),
  component: () => ({ name: '', vol: null }),
  addition: () => ({ name: '', vol: null }),
  prow: () => ({ name: '', temp_c: 72, duration_s: 60 }),
  pcycle: () => ({ cycles: 2, steps: [{ name: '', temp_c: 72, duration_s: 30 }] }),
};
export const makeDefault = kind => DEFAULTS[kind]();

export const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'protocol';

export function newProtocolId(name, taken) {
  const base = slug(name);
  let id = base, i = 2;
  while (taken.has(id)) id = `${base}_${i++}`;
  return id;
}

export function blankProtocol(takenIds) {
  return {
    id: newProtocolId('my protocol', takenIds), name: 'My protocol', description: '', default_overage_pct: 10, unit_label: 'reactions',
    sections: [{ title: '1. First section', steps: [makeDefault('step')] }], custom: true, revision: 1,
  };
}

export function duplicateProtocol(base, takenIds) {
  const p = clone(base);
  p.based_on = base.id;
  p.name = `${base.name} (copy)`;
  p.id = newProtocolId(p.name, takenIds);
  p.custom = true;
  p.revision = 1;
  delete p.version;
  return p;
}

/* ---------- field specs the editor renders from ---------- */
// kind: text | area | num (optional number) | numreq (required number) | dur | noDispense
export const FIELDS = {
  mix: [
    { path: 'title', label: 'Title', kind: 'text' },
    { path: 'input.name', label: 'Sample added (optional)', kind: 'text', ph: 'e.g. Purified RNA' },
    { path: 'input.vol', label: 'Sample µL per reaction', kind: 'num' },
    { path: 'input.note', label: 'Sample note', kind: 'text', ph: 'e.g. about 1 ug per hyb' },
    { path: 'dispense_vol', label: 'Dispense µL (override)', kind: 'num', ph: 'default: sum of the mix' },
    { path: 'dispense', label: 'Prepare only, nothing to dispense', kind: 'noDispense' },
    { path: 'note', label: 'Note', kind: 'text' },
  ],
  thermocycle: [
    { path: 'title', label: 'Title', kind: 'text' },
    { path: 'lid_c', label: 'Lid °C (optional)', kind: 'num' },
    { path: 'note', label: 'Note', kind: 'text' },
  ],
  cleanup: [
    { path: 'title', label: 'Title', kind: 'text' },
    { path: 'sample', label: 'Sample', kind: 'text' },
    { path: 'sample_vol', label: 'Sample µL', kind: 'numreq' },
    { path: 'bead', label: 'Beads', kind: 'text' },
    { path: 'bead_vol', label: 'Bead µL', kind: 'numreq' },
    { path: 'bind_min', label: 'Bind (min)', kind: 'numreq' },
    { path: 'wash', label: 'Wash', kind: 'text' },
    { path: 'dry_min', label: 'Dry (min)', kind: 'numreq' },
    { path: 'elute_vol', label: 'Elute in µL', kind: 'numreq' },
    { path: 'elute_min', label: 'Elute (min)', kind: 'numreq' },
    { path: 'transfer_vol', label: 'Transfer µL', kind: 'numreq' },
    { path: 'note', label: 'Note', kind: 'text' },
  ],
  step: [
    { path: 'text', label: 'What to do', kind: 'area' },
    { path: 'timer_min', label: 'Timer (min, optional)', kind: 'num' },
    { path: 'per_rxn_vol', label: 'µL per reaction (optional, shows the batch total)', kind: 'num' },
    { path: 'per_label', label: 'Total label (optional)', kind: 'text', ph: 'e.g. per wash' },
    { path: 'note', label: 'Note', kind: 'text' },
  ],
};

export const ROW_FIELDS = {
  component: [{ k: 'name', kind: 'text', ph: 'Component' }, { k: 'vol', kind: 'numreq', ph: 'µL / rxn' }],
  prow: [{ k: 'name', kind: 'text', ph: 'Step name' }, { k: 'temp_c', kind: 'numreq', ph: '°C' }, { k: 'duration_s', kind: 'dur', ph: 'e.g. 30 s, 10 min, hold' }],
};

/* ---------- validation, in plain words ---------- */
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const blank = v => !String(v ?? '').trim();

function checkProgram(rows, where, bad, nested = false) {
  if (!rows?.length) return bad(where, 'has no temperature steps');
  rows.forEach((r, i) => {
    const w = `${where}, ${nested ? 'cycle ' : ''}row ${i + 1}`;
    if (r.cycles !== undefined) {
      if (nested) return bad(w, 'a cycle cannot sit inside a cycle');
      if (!Number.isInteger(r.cycles) || r.cycles < 1) bad(w, 'cycle count must be a whole number, 1 or more');
      return checkProgram(r.steps, w, bad, true);
    }
    if (blank(r.name)) bad(w, 'needs a name');
    if (!isNum(r.temp_c) || r.temp_c < 0 || r.temp_c > 110) bad(w, 'needs a temperature between 0 and 110 °C');
    if (r.duration_s !== null && !(isNum(r.duration_s) && r.duration_s > 0)) bad(w, 'needs a time like "30 s" or "10 min", or "hold"');
  });
}

/** Returns a list of readable problems; an empty list means the protocol can be saved. */
export function validateProtocol(p) {
  const errs = [];
  const bad = (where, msg) => errs.push(`${where}: ${msg}`);
  if (blank(p.name)) bad('Protocol', 'needs a name');
  if (blank(p.unit_label)) bad('Protocol', 'needs a unit label such as "reactions"');
  if (!(isNum(p.default_overage_pct) && p.default_overage_pct >= 0 && p.default_overage_pct <= 50)) bad('Protocol', 'default overage must be between 0 and 50 %');
  if (!p.sections?.length) bad('Protocol', 'needs at least one section');
  p.sections?.forEach((sec, si) => {
    const sw = `Section ${si + 1}${sec.title ? ` "${sec.title}"` : ''}`;
    if (blank(sec.title)) bad(sw, 'needs a title');
    if (!sec.steps?.length) bad(sw, 'has no steps');
    sec.steps?.forEach((st, ti) => {
      const w = `${sw}, step ${ti + 1}${st.title ? ` "${st.title}"` : ''}`;
      if (st.type !== 'step' && blank(st.title)) bad(w, 'needs a title');
      if (st.type === 'mix') {
        (st.components || []).forEach((c, i) => {
          if (blank(c.name)) bad(w, `component ${i + 1} needs a name`);
          if (!(isNum(c.vol) && c.vol > 0)) bad(w, `component ${i + 1} needs a volume above 0`);
        });
        (st.add || []).forEach((c, i) => {
          if (blank(c.name)) bad(w, `per-reaction addition ${i + 1} needs a name`);
          if (!(isNum(c.vol) && c.vol > 0)) bad(w, `per-reaction addition ${i + 1} needs a volume above 0`);
        });
        if (!(st.components || []).length && !(st.add || []).length && blank(st.input?.name)) bad(w, 'is empty: add a component, an addition or a sample');
        if (st.dispense_vol !== undefined && !(isNum(st.dispense_vol) && st.dispense_vol > 0)) bad(w, 'dispense volume must be above 0');
      } else if (st.type === 'thermocycle') {
        checkProgram(st.program, w, bad);
      } else if (st.type === 'cleanup') {
        for (const k of ['sample', 'bead', 'wash']) if (blank(st[k])) bad(w, `"${k}" is empty`);
        for (const k of ['sample_vol', 'bead_vol', 'elute_vol', 'transfer_vol']) if (!(isNum(st[k]) && st[k] > 0)) bad(w, `${k.replace('_', ' ')} needs a number above 0`);
        for (const k of ['bind_min', 'dry_min', 'elute_min']) if (!(isNum(st[k]) && st[k] >= 0)) bad(w, `${k.replace('_', ' ')} needs a number, 0 or more`);
      } else if (st.type === 'step') {
        if (blank(st.text)) bad(w, 'needs text');
        if (st.timer_min !== undefined && !(isNum(st.timer_min) && st.timer_min > 0)) bad(w, 'timer must be above 0 minutes');
        if (st.per_rxn_vol !== undefined && !(isNum(st.per_rxn_vol) && st.per_rxn_vol > 0)) bad(w, 'µL per reaction must be above 0');
      } else bad(w, `unknown step type "${st.type}"`);
    });
  });
  return errs;
}

/** A clean copy for saving: trimmed strings, empty optional fields removed, empty `input` dropped. */
export function normalizeProtocol(p) {
  const clean = v => {
    if (Array.isArray(v)) return v.map(x => clean(x));
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        const c = clean(x);
        const keepNull = k === 'duration_s'; // null means an open-ended hold
        const emptyAdd = k === 'add' && Array.isArray(c) && !c.length;
        if (c === undefined || c === '' || (c === null && !keepNull) || emptyAdd) continue;
        out[k] = c;
      }
      return out;
    }
    return typeof v === 'string' ? v.trim() : v;
  };
  const out = clean(p);
  for (const sec of out.sections || []) {
    for (const st of sec.steps || []) {
      if (st.type === 'mix') {
        st.components ??= [];
        if (st.input && !st.input.name) delete st.input;
        if (st.dispense !== undefined && st.dispense !== false) delete st.dispense;
      }
    }
  }
  return out;
}
