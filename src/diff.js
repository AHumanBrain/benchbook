// Compare two protocols (or two batches) and say what changed, in plain words. Pure, no DOM.
import { fmt } from './calc.js';
import { durationText } from './protocol_edit.js';

const FIELD_LABEL = {
  note: 'note', dispense_vol: 'dispense volume', dispense: 'dispense', lid_c: 'lid temperature', timer_min: 'timer', per_rxn_vol: 'µL per reaction',
  per_label: 'total label', sample: 'sample', sample_vol: 'sample volume', bead: 'beads', bead_vol: 'bead volume', bind_min: 'bind time',
  wash: 'wash', elute_buffer: 'elution buffer', dry_min: 'dry time', elute_vol: 'elution volume', elute_min: 'elution time', transfer_vol: 'transfer volume',
};
const UNIT = { dispense_vol: ' µL', lid_c: ' °C', timer_min: ' min', per_rxn_vol: ' µL', sample_vol: ' µL', bead_vol: ' µL', bind_min: ' min', dry_min: ' min', elute_vol: ' µL', elute_min: ' min', transfer_vol: ' µL' };

const show = (v, unit = '') => (v === undefined || v === null || v === '' ? 'none' : typeof v === 'number' ? `${fmt(v)}${unit}` : typeof v === 'boolean' ? String(v) : `"${v}"`);
const same = (a, b) => (a ?? null) === (b ?? null);
const key = s => `${s.type}|${String(s.title ?? s.text ?? '').trim().toLowerCase()}`;

/** Pair up two lists by key; repeats of one key pair up in order. */
function pair(listA, listB, keyFn) {
  const bucket = new Map();
  for (const b of listB) { const k = keyFn(b); bucket.set(k, [...(bucket.get(k) || []), b]); }
  const pairs = [], onlyA = [];
  for (const a of listA) {
    const q = bucket.get(keyFn(a));
    if (q?.length) pairs.push([a, q.shift()]); else onlyA.push(a);
  }
  return { pairs, onlyA, onlyB: [...bucket.values()].flat() };
}

/** Program rows flattened to keyed rows so edits are found even when steps are added. */
function programRows(program) {
  const out = [];
  let cyc = 0;
  for (const item of program || []) {
    if (item.cycles !== undefined) {
      cyc++;
      out.push({ label: `repeat group ${cyc}`, cycles: item.cycles });
      for (const r of item.steps || []) out.push({ label: `${r.name} (in repeat group ${cyc})`, row: r });
    } else out.push({ label: item.name, row: item });
  }
  return out;
}

export function diffProtocols(a, b) {
  const out = [];
  const add = (kind, where, what, from, to) => {
    const text = kind === 'changed' ? `${where}: ${what} ${from} → ${to}` : kind === 'added' ? `${where}: added ${what}` : `${where}: removed ${what}`;
    out.push({ kind, where, what, from, to, text });
  };

  if (a.name !== b.name) add('changed', 'Protocol', 'name', show(a.name), show(b.name));
  if (!same(a.default_overage_pct, b.default_overage_pct)) add('changed', 'Protocol', 'default overage', show(a.default_overage_pct, ' %'), show(b.default_overage_pct, ' %'));

  const secs = pair(a.sections || [], b.sections || [], s => String(s.title).trim().toLowerCase());
  for (const s of secs.onlyA) add('removed', 'Protocol', `section "${s.title}"`);
  for (const s of secs.onlyB) add('added', 'Protocol', `section "${s.title}"`);
  for (const [sa, sb] of secs.pairs) {
    const st = pair(sa.steps || [], sb.steps || [], key);
    for (const s of st.onlyA) add('removed', sa.title, `step "${s.title ?? s.text}"`);
    for (const s of st.onlyB) add('added', sa.title, `step "${s.title ?? s.text}"`);
    for (const [x, y] of st.pairs) diffStep(x, y, `${sa.title} › ${x.title ?? String(x.text).slice(0, 50)}`, add);
  }
  return out;
}

function diffStep(x, y, where, add) {
  for (const k of Object.keys(FIELD_LABEL)) {
    if (!same(x[k], y[k])) add('changed', where, FIELD_LABEL[k], show(x[k], UNIT[k]), show(y[k], UNIT[k]));
  }
  for (const k of ['name', 'vol', 'note']) {
    if (!same(x.input?.[k], y.input?.[k])) add('changed', where, `sample ${k === 'vol' ? 'volume' : k}`, show(x.input?.[k], k === 'vol' ? ' µL' : ''), show(y.input?.[k], k === 'vol' ? ' µL' : ''));
  }
  for (const [list, label] of [['components', 'component'], ['add', 'per-reaction item']]) {
    const m = pair(x[list] || [], y[list] || [], c => c.name.trim().toLowerCase());
    for (const c of m.onlyA) add('removed', where, `${label} "${c.name}"`);
    for (const c of m.onlyB) add('added', where, `${label} "${c.name}" (${fmt(c.vol)} µL)`);
    for (const [p, q] of m.pairs) if (!same(p.vol, q.vol)) add('changed', where, `"${p.name}" volume`, show(p.vol, ' µL'), show(q.vol, ' µL'));
  }
  if (x.program || y.program) {
    const m = pair(programRows(x.program), programRows(y.program), r => r.label.toLowerCase());
    for (const r of m.onlyA) add('removed', where, `temperature step "${r.label}"`);
    for (const r of m.onlyB) add('added', where, `temperature step "${r.label}"`);
    for (const [p, q] of m.pairs) {
      if (p.cycles !== undefined) { if (p.cycles !== q.cycles) add('changed', where, `${p.label} cycles`, String(p.cycles), String(q.cycles)); continue; }
      if (!same(p.row.temp_c, q.row.temp_c)) add('changed', where, `"${p.label}" temperature`, show(p.row.temp_c, ' °C'), show(q.row.temp_c, ' °C'));
      if (!same(p.row.duration_s, q.row.duration_s)) add('changed', where, `"${p.label}" time`, durationText(p.row.duration_s), durationText(q.row.duration_s));
    }
  }
}

const SETTINGS = [
  ['Protocol', b => b.protocol.name], ['Protocol revision', b => b.protocol.revision ?? 'built in'], ['Count', b => `${b.n} ${b.protocol.unit_label}`],
  ['Master-mix overage', b => `${b.overagePct} %`], ['Library prep date', b => b.info?.prep || ''], ['Hyb date', b => b.info?.hyb || ''],
  ['Capture date', b => b.info?.cap || ''], ['Sequencing date', b => b.info?.seq || ''], ['Thermocycler', b => b.info?.thermocycler || ''],
  ['Co-processed with', b => b.info?.cohyb || ''],
];

/** Everything that differs between two batches. `summarizeSet` turns QC rows into numbers (injected to stay pure). */
export function diffBatches(a, b, { summarizeSet } = {}) {
  const settings = SETTINGS.map(([label, get]) => ({ label, a: String(get(a)), b: String(get(b)) })).map(r => ({ ...r, changed: r.a !== r.b }));
  const protocol = diffProtocols(a.protocol, b.protocol);
  const notes = batch => {
    const counts = {};
    const list = [];
    for (const [key, st] of Object.entries(batch.state || {})) for (const n of st.notes || []) { counts[n.tag] = (counts[n.tag] || 0) + 1; list.push({ ...n, key }); }
    return { counts, list };
  };
  const labels = [...new Set([...a.qc.sets, ...b.qc.sets].map(s => s.label))];
  const qc = summarizeSet ? labels.map(label => {
    const sa = a.qc.sets.find(s => s.label === label), sb = b.qc.sets.find(s => s.label === label);
    return { label, a: sa ? summarizeSet(sa.rows) : null, b: sb ? summarizeSet(sb.rows) : null };
  }) : [];
  return { settings, protocol, notes: { a: notes(a), b: notes(b) }, qc };
}
