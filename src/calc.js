// Pure functions: no DOM, no storage. Unit-tested in test/calc.test.mjs.

export const round = (v, d = 2) => Math.round((v + Number.EPSILON) * 10 ** d) / 10 ** d;

export const fmt = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? '–' : String(round(v, d)));

/** "10 min", "45 s", "1 h 5 min", or "∞" for an open-ended hold. */
export function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined) return '∞';
  if (seconds < 120) return `${fmt(seconds)} s`;
  const min = Math.round(seconds / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Master-mix arithmetic for a `mix` step.
 *  Components are master-mixed (overage applied); `add` rows are pipetted per reaction (no overage). */
export function mixTable(step, n, overagePct) {
  const factor = 1 + overagePct / 100;
  const components = step.components || [];
  const mmRows = components.map(c => ({ name: c.name, perRxn: c.vol, total: c.vol * n * factor }));
  const mmPerRxn = components.reduce((s, c) => s + c.vol, 0);
  const dispense = step.dispense === false || !components.length ? null : step.dispense_vol ?? mmPerRxn;
  const addRows = (step.add || []).map(a => ({ name: a.name, perRxn: a.vol, total: a.vol * n }));
  const inputVol = step.input && typeof step.input.vol === 'number' ? step.input.vol : null;
  const finalVol = (inputVol ?? 0) + (dispense ?? 0) + addRows.reduce((s, a) => s + a.perRxn, 0);
  return {
    mmRows,
    mmPerRxn,
    mmTotal: mmRows.reduce((s, r) => s + r.total, 0),
    dispense,
    addRows,
    finalVol: finalVol || null,
  };
}

/** Total run time in seconds of a thermocycler program (cycles expanded, open holds ignored). */
export function programSeconds(program) {
  return program.reduce((sum, item) => {
    if (item.cycles) return sum + item.cycles * programSeconds(item.steps);
    return sum + (item.duration_s || 0);
  }, 0);
}

/** A bead cleanup becomes an ordered list of plain bench steps, so each can be ticked and timed. */
export function expandCleanup(s) {
  return [
    { type: 'step', text: `${s.title}: add ${fmt(s.bead_vol)} µL ${s.bead} to ${fmt(s.sample_vol)} µL ${s.sample}. Mix and bind.`, per_rxn_vol: s.bead_vol, timer_min: s.bind_min, note: s.note },
    { type: 'step', text: `Magnet, discard supernatant. Wash: ${s.wash}.` },
    { type: 'step', text: 'Air-dry the beads.', timer_min: s.dry_min },
    { type: 'step', text: `Elute in ${fmt(s.elute_vol)} µL Tris (5 mM) or water.`, per_rxn_vol: s.elute_vol, timer_min: s.elute_min },
    { type: 'step', text: `Transfer ${fmt(s.transfer_vol)} µL eluate to a fresh tube.`, per_rxn_vol: s.transfer_vol },
  ];
}

/** Flatten a protocol into ordered bench items with stable keys (section.step[.sub]). */
export function flattenProtocol(protocol) {
  const items = [];
  protocol.sections.forEach((section, si) => {
    section.steps.forEach((step, ti) => {
      if (step.type === 'cleanup') {
        expandCleanup(step).forEach((sub, k) => items.push({ key: `${si}.${ti}.${k}`, si, step: sub, heading: k === 0 ? step.title : null }));
      } else {
        items.push({ key: `${si}.${ti}`, si, step, heading: null });
      }
    });
  });
  return items;
}

export function newBatch(protocol, { name, n, overagePct, id }) {
  return {
    id: id || `b${Date.now().toString(36)}`,
    name,
    n,
    overagePct,
    created: new Date().toISOString(),
    protocol, // a snapshot, so a batch stays reproducible after the protocol is edited
    info: { prep: '', hyb: '', cap: '', seq: '', thermocycler: '', cohyb: '' },
    state: {}, // key -> { done: ISO | null, timer: ISO end | null, notes: [{ t, tag, text }] }
  };
}

export const NOTE_TAGS = ['observation', 'deviation', 'error', 'idea'];

export function progress(batch, items) {
  const done = items.filter(it => batch.state[it.key]?.done).length;
  return { done, total: items.length };
}

/** All notes of a batch, in step order, with the step they belong to. */
export function collectNotes(batch, items) {
  const out = [];
  for (const it of items) {
    for (const note of batch.state[it.key]?.notes || []) out.push({ ...note, key: it.key, step: it.step.title || it.step.text });
  }
  return out;
}
