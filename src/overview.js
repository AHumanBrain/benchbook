// Numbers for the graphs. Pure, no DOM.
import { flagRow } from './qc.js';

const key = s => String(s).trim().toLowerCase();

export const median = arr => {
  const v = arr.filter(x => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
};

export const METRICS = {
  conc: { label: 'Concentration (ng/µL)', get: r => r.conc, codes: ['conc-low', 'no-conc'] },
  r280: { label: '260/280', get: r => r.r280, codes: ['r280-low', 'r280-high'] },
  r230: { label: '260/230', get: r => r.r230, codes: ['r230-low'] },
};

/** Batch date for ordering: the library-prep date if entered, else when the batch was created. */
export const batchDate = b => (b.info?.prep ? `${b.info.prep}T12:00:00` : b.created);

/** The batch to compare against: the latest earlier batch on the same protocol, else the latest earlier one. */
export function previousBatch(batches, b) {
  const earlier = Object.values(batches).filter(x => x.id !== b.id && batchDate(x) < batchDate(b)).sort((x, y) => batchDate(y).localeCompare(batchDate(x)));
  return earlier.find(x => x.protocol.id === b.protocol.id) || earlier[0] || null;
}

/** QC labels used across batches, the most common first. */
export function qcLabels(batches) {
  const count = new Map();
  for (const b of Object.values(batches)) for (const l of new Set(b.qc.sets.map(s => s.label))) count.set(l, (count.get(l) || 0) + 1);
  return [...count.entries()].map(([label, n]) => ({ label, batches: n })).sort((a, b) => b.batches - a.batches || a.label.localeCompare(b.label));
}

/** Per batch: every library's value, oldest batch first. `newProtocol` marks where the protocol changed. */
export function series(batches, label, metric, thr) {
  const m = METRICS[metric];
  const out = [];
  for (const b of Object.values(batches).sort((x, y) => batchDate(x).localeCompare(batchDate(y)))) {
    const set = b.qc.sets.find(s => s.label === label);
    if (!set) continue;
    const points = set.rows.filter(r => m.get(r) != null).map(r => ({ v: m.get(r), name: r.name, flagged: flagRow(r, thr).some(f => m.codes.includes(f.code)) }));
    const prev = out[out.length - 1];
    out.push({
      id: b.id, name: b.name, date: batchDate(b), protocolId: b.protocol.id, revision: b.protocol.revision ?? null, points,
      median: median(points.map(p => p.v)),
      newProtocol: !!prev && (prev.protocolId !== b.protocol.id || prev.revision !== (b.protocol.revision ?? null)),
    });
  }
  return out;
}

/** The QC set that stands for "the libraries" of a batch: the plate's set, else one labelled like libraries, else the first. */
export function libraryQcSet(b) {
  return b.qc.sets.find(s => s.id === b.plate.qcSetId) || b.qc.sets.find(s => /librar|capture/i.test(s.label)) || b.qc.sets[0] || null;
}

/** One bar per library of one batch: its value, whether it is flagged, and its hyb pool (if any). */
export function libraryBars(b, setId, metric, thr) {
  const set = b.qc.sets.find(s => s.id === setId) || libraryQcSet(b);
  if (!set) return { set: null, bars: [] };
  const m = METRICS[metric];
  const pool = new Map(b.plate.samples.map(s => [key(s.name), s.pool]));
  const bars = set.rows.filter(r => m.get(r) != null).map(r => ({
    name: r.name, v: m.get(r), flagged: flagRow(r, thr).some(f => m.codes.includes(f.code)), pool: pool.get(key(r.name)) ?? null,
  }));
  return { set, bars };
}
