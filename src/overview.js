// Numbers for the graphs. Pure, no DOM.
import { flagRow } from './qc.js';
import { roleOf } from './runs.js';
import { batchDate } from './dates.js';

export { batchDate };

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

/** The batch to compare against: the latest earlier batch of the same kind (a prep with a prep, a hyb with a hyb), preferring the
 *  same protocol. */
export function previousBatch(batches, b) {
  const earlier = Object.values(batches).filter(x => x.id !== b.id && roleOf(x) === roleOf(b) && batchDate(x) < batchDate(b))
    .sort((x, y) => batchDate(y).localeCompare(batchDate(x)));
  return earlier.find(x => x.protocol.id === b.protocol.id) || earlier[0] || null;
}

/** QC labels used across batches, the most common first. */
export function qcLabels(batches) {
  const count = new Map();
  for (const b of Object.values(batches)) for (const l of new Set(b.qc.sets.map(s => s.label))) count.set(l, (count.get(l) || 0) + 1);
  return [...count.entries()].map(([label, n]) => ({ label, batches: n })).sort((a, b) => b.batches - a.batches || a.label.localeCompare(b.label));
}

/** The hyb pool each reading belongs to, in step with `set.rows`: null when unknown.
 *  A prep knows it from its plate (by library name). In a hyb batch each reading is one pool, in order (reading 1 is pool 1),
 *  provided the batch is linked to a prep that has pools. */
export function poolsFor(b, batches, set) {
  if (roleOf(b) === 'hyb') {
    const pooledPrep = (b.links || []).map(id => batches[id]).some(x => x && roleOf(x) === 'prep' && x.plate?.samples?.some(s => s.pool));
    return set.rows.map((_, i) => (pooledPrep ? i + 1 : null));
  }
  const pool = new Map((b.plate?.samples || []).map(s => [key(s.name), s.pool]));
  return set.rows.map(r => pool.get(key(r.name)) ?? null);
}

/** The largest value of a measurement in any batch, so charts of different batches can share one scale. */
export function scaleMax(batches, label, metric) {
  const m = METRICS[metric];
  const all = Object.values(batches).flatMap(b => b.qc.sets.filter(s => s.label === label).flatMap(s => s.rows.map(m.get))).filter(v => v != null);
  return all.length ? Math.max(...all) : null;
}

/** Per batch: every library's value, oldest batch first. `newProtocol` marks where the protocol changed. */
export function series(batches, label, metric, thr) {
  const m = METRICS[metric];
  const out = [];
  for (const b of Object.values(batches).sort((x, y) => batchDate(x).localeCompare(batchDate(y)))) {
    const set = b.qc.sets.find(s => s.label === label);
    if (!set) continue;
    const pools = poolsFor(b, batches, set);
    const points = set.rows.map((r, i) => ({ r, pool: pools[i] })).filter(({ r }) => m.get(r) != null)
      .map(({ r, pool }) => ({ v: m.get(r), name: r.name, pool, flagged: flagRow(r, thr).some(f => m.codes.includes(f.code)) }));
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

/** One dot per reading of one batch: its value, whether it is flagged, and its hyb pool (if known). */
export function libraryPoints(b, batches, setId, metric, thr) {
  const set = b.qc.sets.find(s => s.id === setId) || libraryQcSet(b);
  if (!set) return { set: null, points: [] };
  const m = METRICS[metric];
  const pools = poolsFor(b, batches, set);
  const points = set.rows.map((r, i) => ({ r, pool: pools[i] })).filter(({ r }) => m.get(r) != null)
    .map(({ r, pool }) => ({ name: r.name, v: m.get(r), flagged: flagRow(r, thr).some(f => m.codes.includes(f.code)), pool }));
  return { set, points };
}
