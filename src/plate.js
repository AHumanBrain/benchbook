// 96-well index plate and hyb-pool arithmetic. Pure, no DOM.

export const ROWS = [...'ABCDEFGH'];
export const COLS = 12;
const ROW_WISE = ROWS.flatMap(r => Array.from({ length: COLS }, (_, c) => `${r}${c + 1}`));
const COL_WISE = Array.from({ length: COLS }, (_, c) => ROWS.map(r => `${r}${c + 1}`)).flat();

/** Wells in fill order: 'row' = A1..A12, B1.. ; 'col' = A1..H1, A2.. */
export const wellOrder = order => (order === 'col' ? COL_WISE : ROW_WISE);

/** "a01" / "A1" -> "A1"; anything that is not a well on a 96 plate -> null. */
export function parseWell(s) {
  const m = /^([A-Ha-h])0*([1-9]|1[0-2])$/.exec(String(s ?? '').trim());
  return m ? `${m[1].toUpperCase()}${m[2]}` : null;
}

export const defaultPlate = () => ({
  plateId: null, start: 'A1', order: 'row', skipFlagged: true, skipUsed: true,
  plex: 3, targetNg: 1000, availUl: 20, qcSetId: null, samples: [],
});

export const autoPool = (count, plex) => Array.from({ length: count }, (_, i) => Math.floor(i / Math.max(1, plex)) + 1);

/** Wells of one plate already used by OTHER batches: Map well -> { batchId, batch, sample }. */
export function plateUses(batches, plateId, exceptId) {
  const uses = new Map();
  if (!plateId) return uses;
  for (const b of Object.values(batches)) {
    if (b.id === exceptId || b.plate?.plateId !== plateId) continue;
    for (const s of b.plate.samples) if (s.well) uses.set(s.well, { batchId: b.id, batch: b.name, sample: s.name });
  }
  return uses;
}

/** Give every sample the next free well, in fill order from `start`. Mutates plate.samples.
 *  Returns how many samples did not fit on the plate. */
export function assignWells(plate, flags, uses) {
  const blocked = new Set([...(plate.skipFlagged ? Object.keys(flags || {}) : []), ...(plate.skipUsed ? uses.keys() : [])]);
  const seq = wellOrder(plate.order);
  let i = Math.max(0, seq.indexOf(parseWell(plate.start) || 'A1'));
  let unassigned = 0;
  for (const s of plate.samples) {
    while (i < seq.length && blocked.has(seq[i])) i++;
    s.well = i < seq.length ? seq[i++] : null;
    if (!s.well) unassigned++;
  }
  return unassigned;
}

const key = s => String(s).trim().toLowerCase();

/** Everything worth a warning before the plate goes to the bench. Returns [{ level, text }]. */
export function plateIssues(plate, flags = {}, uses = new Map(), qcRows = null) {
  const out = [];
  const names = plate.samples.map(s => key(s.name));
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  if (dup.length) out.push({ level: 'bad', text: `Duplicate sample names: ${[...new Set(dup)].join(', ')}` });
  const unassigned = plate.samples.filter(s => !s.well);
  if (unassigned.length) out.push({ level: 'warn', text: `${unassigned.length} sample(s) have no well yet: ${unassigned.slice(0, 5).map(s => s.name).join(', ')}${unassigned.length > 5 ? ', …' : ''}. Press "Assign wells".` });
  const wells = plate.samples.filter(s => s.well).map(s => s.well);
  const dupWell = wells.filter((w, i) => wells.indexOf(w) !== i);
  if (dupWell.length) out.push({ level: 'bad', text: `The same well is used twice: ${[...new Set(dupWell)].join(', ')}` });
  for (const s of plate.samples) {
    if (!s.well) continue;
    if (flags[s.well]) out.push({ level: 'warn', text: `${s.name} is on ${s.well}, flagged: ${flags[s.well]}` });
    const u = uses.get(s.well);
    if (u) out.push({ level: 'warn', text: `${s.name} is on ${s.well}, which batch "${u.batch}" also uses (sample ${u.sample}). Fine unless they share a sequencing run.` });
  }
  if (qcRows) {
    const have = new Set(qcRows.map(r => key(r.name)));
    const missing = plate.samples.filter(s => !have.has(key(s.name)));
    if (missing.length) out.push({ level: 'warn', text: `No QC measurement for ${missing.length} sample(s): ${missing.slice(0, 5).map(s => s.name).join(', ')}${missing.length > 5 ? ', …' : ''}` });
  }
  const unpooled = plate.samples.filter(s => !s.pool);
  if (unpooled.length) out.push({ level: 'warn', text: `${unpooled.length} sample(s) are not in a pool.` });
  return out;
}

/** Equal-mass pooling for hyb. For each pool: ng per library, µL to take, and whether the available volume
 *  limits the total. Pool size k means each library contributes targetNg / k. */
export function poolPlan(samples, qcRows, { targetNg = 1000, availUl = 20 } = {}) {
  const conc = new Map((qcRows || []).map(r => [key(r.name), r.conc]));
  const byPool = new Map();
  for (const s of samples) if (s.pool) byPool.set(s.pool, [...(byPool.get(s.pool) || []), s]);
  return [...byPool.entries()].sort((a, b) => a[0] - b[0]).map(([pool, members]) => {
    const k = members.length;
    const wantEach = targetNg / k;
    const rows = members.map(s => ({ name: s.name, well: s.well || null, conc: conc.get(key(s.name)) ?? null }));
    const known = rows.filter(r => r.conc != null && r.conc > 0);
    let limiter = null, each = wantEach;
    for (const r of known) {
      const cap = r.conc * availUl;
      if (cap < each) { each = cap; limiter = r; }
    }
    for (const r of rows) {
      r.ng = r.conc ? each : null;
      r.ul = r.conc ? each / r.conc : null;
    }
    const ulKnown = rows.reduce((s, r) => s + (r.ul || 0), 0);
    return {
      pool, k, rows, wantEach, each,
      limitedBy: limiter ? limiter.name : null,
      missing: rows.filter(r => !r.conc).map(r => r.name),
      totalUl: ulKnown,
      totalNg: each * known.length,
      shortfall: limiter ? targetNg - each * k : 0,
    };
  });
}

const csvCell = v => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));

/** One line per sample: plate, well, pool, concentration and the µL to take into its pool. */
export function plateMapCsv(plateName, samples, plan) {
  const ul = new Map();
  for (const p of plan) for (const r of p.rows) ul.set(key(r.name), { conc: r.conc, ul: r.ul });
  const lines = [['Sample', 'Plate', 'Well', 'Pool', 'Conc_ng_per_uL', 'Volume_uL_to_pool']];
  for (const s of samples) {
    const q = ul.get(key(s.name)) || {};
    lines.push([s.name, plateName || '', s.well || '', s.pool || '', q.conc != null ? Math.round(q.conc * 100) / 100 : '', q.ul != null ? Math.round(q.ul * 100) / 100 : '']);
  }
  return lines.map(r => r.map(csvCell).join(',')).join('\n') + '\n';
}
