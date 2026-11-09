// Starting the next batch from an earlier one, and a hyb batch from a prep. Pure, no DOM.
import { newBatch } from './calc.js';
import { assignWells, plateUses, autoPool, wellOrder } from './plate.js';
import { roleOf } from './runs.js';
import { batchDate } from './overview.js';

/** "Batch 5 · prep" -> "Batch 6 · prep" (the last number goes up until the name is free); no number -> "name (2)". */
export function bumpName(name, taken) {
  const used = new Set([...taken].map(n => String(n).toLowerCase()));
  const m = /^(.*?)(\d+)(\D*)$/.exec(name);
  const make = i => (m ? `${m[1]}${Number(m[2]) + i}${m[3]}` : `${name} (${i + 1})`);
  let i = 1;
  while (used.has(make(i).toLowerCase())) i++;
  return make(i);
}

export function todayLocal(now = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** "Batch 5 · prep" -> "Batch 5 · hyb". */
export function hybName(prepName) {
  return /·\s*prep\b/i.test(prepName) ? prepName.replace(/·\s*prep\b/i, '· hyb') : `${prepName} · hyb`;
}

/** Where to start filling a plate: the well after this batch's last one, else after the last well anyone used. */
export function nextStartWell(orderName, usedElsewhere, ownWells) {
  const seq = wellOrder(orderName);
  const idx = list => [...list].map(w => seq.indexOf(w)).filter(i => i >= 0);
  const own = idx(ownWells), used = idx(usedElsewhere);
  const from = own.length ? Math.max(...own) + 1 : used.length ? Math.max(...used) + 1 : 0;
  return seq[from] ?? seq[0];
}

/** The index plate a new prep batch should use: the one the source batch used, else the latest prep's, else the only plate. */
function plateFor(from, batches, plates) {
  if (from.plate?.plateId && plates[from.plate.plateId]) return plates[from.plate.plateId];
  const withPlate = Object.values(batches).filter(b => b.plate?.plateId && plates[b.plate.plateId]).sort((a, b) => batchDate(b).localeCompare(batchDate(a)));
  if (withPlate.length) return plates[withPlate[0].plate.plateId];
  const all = Object.values(plates);
  return all.length === 1 ? all[0] : null;
}

/** A new batch like `from`: same protocol (or the one given), overage, thermocycler and plate settings; fresh libraries on the
 *  next free wells; nothing ticked, no readings. Returns { batch, wells, unassigned, plateName }. */
export function planNextBatch({ from, batches, plates, name, n, overagePct, protocol, today, id }) {
  const b = newBatch(protocol, { name, n, overagePct, id });
  const role = roleOf(from);
  b.role = role;
  b.info.thermocycler = from.info?.thermocycler || '';
  if (role === 'hyb') b.info.hyb = today; else b.info.prep = today;
  const result = { batch: b, wells: [], unassigned: 0, plateName: '' };
  if (role !== 'prep') return result;
  const plate = plateFor(from, batches, plates);
  const s = from.plate || {};
  const plex = s.plex || 3;
  const pools = autoPool(n, plex);
  b.plate = {
    plateId: plate?.id || null, start: 'A1', order: s.order || 'row', skipFlagged: s.skipFlagged ?? true, skipUsed: s.skipUsed ?? true,
    plex, targetNg: s.targetNg || 1000, availUl: s.availUl || 20, qcSetId: null,
    samples: Array.from({ length: n }, (_, i) => ({ name: `Sample ${i + 1}`, well: null, pool: pools[i] })),
  };
  if (!plate) return result;
  const uses = plateUses(batches, plate.id, b.id);
  const ownWells = (from.plate?.plateId === plate.id ? from.plate.samples : []).map(x => x.well).filter(Boolean);
  b.plate.start = nextStartWell(b.plate.order, uses.keys(), ownWells);
  let left = assignWells(b.plate, plate.flags, uses);
  if (left) {                       // not enough room after the last well: fill the gaps from the top instead
    const retry = structuredClone(b.plate);
    retry.start = 'A1';
    const retryLeft = assignWells(retry, plate.flags, uses);
    if (retryLeft < left) { b.plate = retry; left = retryLeft; }
  }
  result.wells = b.plate.samples.map(x => x.well).filter(Boolean);
  result.unassigned = left;
  result.plateName = plate.name;
  return result;
}

/** A hyb and capture batch for a prep: one hyb per pool, linked both ways (the caller links the prep side), dates copied. */
export function planHybFromPrep({ prep, protocol, previousHyb, name, id }) {
  const pools = new Set((prep.plate?.samples || []).map(s => s.pool).filter(Boolean));
  if (!pools.size) return { error: 'Group the libraries into pools on the Plate & pools tab first.' };
  const overagePct = previousHyb ? previousHyb.overagePct : protocol.default_overage_pct ?? 10;
  const b = newBatch(protocol, { name, n: pools.size, overagePct, id });
  b.role = 'hyb';
  b.links = [prep.id];
  Object.assign(b.info, { hyb: prep.info?.hyb || '', cap: prep.info?.cap || '', seq: prep.info?.seq || '' });
  return { batch: b };
}

/** ["B7","B8","C1"] -> "B7–B8, C1": runs of neighbouring wells in fill order. */
export function wellRanges(wells, orderName = 'row') {
  const seq = wellOrder(orderName);
  const idx = [...new Set(wells.map(w => seq.indexOf(w)).filter(i => i >= 0))].sort((a, b) => a - b);
  const runs = [];
  for (const i of idx) {
    const last = runs[runs.length - 1];
    if (last && i === last[1] + 1) last[1] = i; else runs.push([i, i]);
  }
  return runs.map(([a, b]) => (a === b ? seq[a] : `${seq[a]}–${seq[b]}`)).join(', ');
}
