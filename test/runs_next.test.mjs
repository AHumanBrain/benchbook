import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applySeed, isPristineSeed } from '../src/seed.js';
import { ensureBatch } from '../src/shared.js';
import { roleOf, runsOf, link, unlink, linksOf, runDates, runName } from '../src/runs.js';
import { bumpName, hybName, todayLocal, nextStartWell, planNextBatch, planHybFromPrep, wellRanges } from '../src/nextbatch.js';
import { newBatch } from '../src/calc.js';
import { DEFAULT_THRESHOLDS as THR } from '../src/qc.js';

const seed = JSON.parse(readFileSync(new URL('../data/seed.json', import.meta.url)));
const fresh = () => {
  const db = { batches: {}, plates: {}, protocols: {}, settings: { deleted: {}, qc: { ...THR } } };
  applySeed(db, seed, { ensure: ensureBatch });
  return db;
};
const xgen = JSON.parse(readFileSync(new URL('../protocols/xgen_hyb_wash_v3.json', import.meta.url)));

/* ---------- runs ---------- */
test('roles: stored when present, otherwise guessed from the protocol', () => {
  const db = fresh();
  assert.equal(roleOf(db.batches['seed-b1-prep']), 'prep');
  assert.equal(roleOf(db.batches['seed-b1-hyb']), 'hyb');
  const guessed = { ...db.batches['seed-b1-hyb'], role: undefined };
  assert.equal(roleOf(guessed), 'hyb');
  assert.equal(roleOf({ protocol: { id: 'kapa_rna_hyperprep', name: 'KAPA RNA HyperPrep' } }), 'prep');
  assert.equal(roleOf({ protocol: { id: 'my_copy', based_on: 'xgen_hyb_wash_v3', name: 'mine' } }), 'hyb');
});

test('the workbook becomes 7 runs; batch 5 and the RNA isolation test share one hyb', () => {
  const runs = runsOf(fresh().batches);
  assert.equal(runs.length, 7);
  assert.deepEqual(runs.map(r => r.batches.length).sort(), [1, 2, 2, 2, 2, 2, 3]);
  assert.equal(runs[0].batches[0].id, 'seed-b6-prep');                       // newest first, still unlinked
  const big = runs.find(r => r.batches.length === 3);
  assert.deepEqual(big.batches.map(b => b.id), ['seed-b5-prep', 'seed-rnaiso-prep', 'seed-b5-hyb']);   // preps first, then the hyb
  assert.equal(big.name, 'Batch 5 + RNA iso');
  assert.deepEqual(big.dates, { prep: '2026-10-12', hyb: '2026-10-19', cap: '2026-10-20', seq: '2026-10-22' });
});

test('run dates for a simple pair', () => {
  const db = fresh();
  const run = runsOf(db.batches).find(r => r.batches.some(b => b.id === 'seed-b1-prep'));
  assert.deepEqual(run.dates, { prep: '2026-08-10', hyb: '2026-08-11', cap: '2026-08-12', seq: '2026-08-13' });
  assert.equal(runName(run.batches), 'Batch 1');
  assert.deepEqual(runDates([]), { prep: '', hyb: '', cap: '', seq: '' });
});

test('linking and unlinking work both ways; a link to a missing batch is ignored', () => {
  const a = { id: 'a', protocol: {} }, b = { id: 'b', protocol: {} };
  link(a, b); link(a, b);
  assert.deepEqual([a.links, b.links], [['b'], ['a']]);
  assert.deepEqual(linksOf({ a, b }, a).map(x => x.id), ['b']);
  assert.deepEqual(linksOf({ a }, a), []);
  unlink(a, b);
  assert.deepEqual([a.links, b.links], [[], []]);
  assert.equal(runsOf({ a: { ...a, links: ['ghost'], created: '2026-01-01', info: {} } }).length, 1);
});

/* ---------- next batch ---------- */
test('names count up to a free one', () => {
  assert.equal(bumpName('Batch 5 · prep', ['Batch 5 · prep']), 'Batch 6 · prep');
  assert.equal(bumpName('Batch 5 · prep', ['Batch 6 · prep', 'batch 7 · PREP']), 'Batch 8 · prep');
  assert.equal(bumpName('DNase · prep', []), 'DNase · prep (2)');
  assert.equal(bumpName('DNase · prep', ['DNase · prep (2)']), 'DNase · prep (3)');
  assert.equal(hybName('Batch 5 · prep'), 'Batch 5 · hyb');
  assert.equal(hybName('Run A'), 'Run A · hyb');
  assert.equal(todayLocal(new Date(2026, 10, 9)), '2026-11-09');
});

test('the next start is after this batch, else after the last well anyone used', () => {
  assert.equal(nextStartWell('row', [], ['D1', 'E12']), 'F1');
  assert.equal(nextStartWell('row', ['A1', 'G12'], []), 'H1');
  assert.equal(nextStartWell('row', [], []), 'A1');
  assert.equal(nextStartWell('col', [], ['H1']), 'A2');
});

test('next batch from batch 2: same protocol and settings, 24 fresh libraries on free wells, nothing ticked', () => {
  const db = fresh();
  const from = db.batches['seed-b2-prep'];
  const r = planNextBatch({ from, batches: db.batches, plates: db.plates, name: 'Batch 7 · prep', n: 24, overagePct: from.overagePct, protocol: structuredClone(from.protocol), today: '2026-11-09', id: 'next1' });
  const b = ensureBatch(r.batch);                // as the app does when it stores a new batch
  assert.equal(b.role, 'prep');
  assert.equal(b.info.prep, '2026-11-09');
  assert.equal(b.info.thermocycler, from.info.thermocycler);
  assert.equal(b.protocol.revision, from.protocol.revision);
  assert.equal(b.n, 24);
  assert.deepEqual(b.state, {});
  assert.equal(b.qc.sets.length, 0);
  assert.equal(b.plate.samples.length, 24);
  assert.equal(b.plate.samples[0].name, 'Sample 1');
  assert.deepEqual([b.plate.samples[0].pool, b.plate.samples[23].pool], [1, 8]);
  assert.equal(r.unassigned, 0);
  // the plate is mostly full: batches 1 and 2 and the DNase screen use 66 wells and D1-D8 are flagged. H1-H12 is not enough room,
  // so the gaps are filled from the top: B7-B12, C1-C12, then H1-H6.
  assert.deepEqual([r.wells[0], r.wells[5], r.wells[6], r.wells[17], r.wells[18], r.wells[23]], ['B7', 'B12', 'C1', 'C12', 'H1', 'H6']);
  const taken = new Set(Object.values(db.batches).flatMap(x => x.plate.samples.map(s => s.well).filter(Boolean)));
  assert.ok(r.wells.every(w => !taken.has(w)));
  assert.ok(r.wells.every(w => !['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'].includes(w)));
  assert.equal(r.plateName, 'UDI plate (from workbook)');
});

test('a smaller batch fits after the last used well, in one block', () => {
  const db = fresh();
  const from = db.batches['seed-b2-prep'];
  const r = planNextBatch({ from, batches: db.batches, plates: db.plates, name: 'x', n: 10, overagePct: 5, protocol: from.protocol, today: 't', id: 'n2' });
  assert.deepEqual([r.wells[0], r.wells[9], r.unassigned], ['H1', 'H10', 0]);
});

test('too many libraries for the plate: the rest are reported, not hidden', () => {
  const db = fresh();
  const from = db.batches['seed-b2-prep'];
  const r = planNextBatch({ from, batches: db.batches, plates: db.plates, name: 'x', n: 40, overagePct: 5, protocol: from.protocol, today: 't', id: 'n3' });
  assert.equal(r.wells.length, 30);   // 96 wells minus 66 used (and the flagged D1-D8 are inside used ones)
  assert.equal(r.unassigned, 10);
});

test('a batch with no plate of its own uses the latest one on record', () => {
  const db = fresh();
  const from = db.batches['seed-b5-prep'];               // wells unknown in the workbook
  const r = planNextBatch({ from, batches: db.batches, plates: db.plates, name: 'x', n: 6, overagePct: 5, protocol: from.protocol, today: 't', id: 'n4' });
  assert.equal(r.plateName, 'UDI plate (from workbook)');
  assert.equal(r.wells[0], 'H1');
});

test('next batch from a hyb: same settings, no plate', () => {
  const db = fresh();
  const from = db.batches['seed-b4-hyb'];
  const r = planNextBatch({ from, batches: db.batches, plates: db.plates, name: 'Batch 5 · hyb', n: from.n, overagePct: from.overagePct, protocol: structuredClone(from.protocol), today: '2026-11-09', id: 'n5' });
  assert.equal(r.batch.role, 'hyb');
  assert.equal(r.batch.info.hyb, '2026-11-09');
  assert.equal(r.batch.info.prep, '');
  assert.equal(ensureBatch(r.batch).plate.samples.length, 0);
  assert.equal(r.batch.protocol.revision, 2);
});

test('hyb from a prep: one hyb per pool, linked, dates copied; refuses without pools', () => {
  const db = fresh();
  const prep = db.batches['seed-b1-prep'];
  const ok = planHybFromPrep({ prep, protocol: xgen, previousHyb: db.batches['seed-b4-hyb'], name: 'Batch 1 · hyb (new)', id: 'h1' });
  assert.equal(ok.batch.n, 8);
  assert.equal(ok.batch.role, 'hyb');
  assert.deepEqual(ok.batch.links, ['seed-b1-prep']);
  assert.deepEqual([ok.batch.info.hyb, ok.batch.info.cap, ok.batch.info.seq], ['2026-08-11', '2026-08-12', '2026-08-13']);
  assert.equal(ok.batch.overagePct, db.batches['seed-b4-hyb'].overagePct);
  const none = planHybFromPrep({ prep: db.batches['seed-rnaiso-prep'], protocol: xgen, name: 'x', id: 'h2' });
  assert.match(none.error, /Group the libraries into pools/);
  const dnase = planHybFromPrep({ prep: db.batches['seed-dnase-prep'], protocol: xgen, name: 'x', id: 'h3' });
  assert.equal(dnase.batch.n, 3);
  const blank = newBatch(xgen, { name: 'nothing', n: 1, overagePct: 10, id: 'z' });
  blank.plate = { samples: [] };
  assert.ok(planHybFromPrep({ prep: blank, protocol: xgen, name: 'x', id: 'h4' }).error);
});

/* ---------- seed v2: links arrive without disturbing edits ---------- */
test('the workbook links ship in the seed, both ways, with roles', () => {
  const ids = new Set(seed.batches.map(b => b.id));
  for (const b of seed.batches) {
    assert.ok(['prep', 'hyb'].includes(b.role));
    for (const l of b.links) { assert.ok(ids.has(l)); assert.ok(seed.batches.find(x => x.id === l).links.includes(b.id)); }
  }
  assert.deepEqual(seed.batches.find(b => b.id === 'seed-b5-hyb').links.sort(), ['seed-b5-prep', 'seed-rnaiso-prep']);
  assert.deepEqual(seed.batches.find(b => b.id === 'seed-b6-prep').links, []);
});

test('a newer seed refreshes untouched imports and only adds missing links to edited ones', () => {
  const old = structuredClone(seed);
  old.version = 1;
  for (const b of old.batches) { delete b.links; delete b.role; }
  const db = { batches: {}, plates: {}, protocols: {}, settings: { deleted: {}, qc: { ...THR } } };
  applySeed(db, old, { ensure: ensureBatch });
  assert.equal(db.settings.seedVersion, 1);
  assert.equal(db.batches['seed-b1-prep'].links, undefined);
  db.batches['seed-b2-prep'].name = 'edited by me';                      // an edit
  db.batches['seed-b3-prep'].links = ['somewhere-else'];                  // edited and already linked
  applySeed(db, seed, { ensure: ensureBatch });
  assert.deepEqual(db.batches['seed-b1-prep'].links, ['seed-b1-hyb']);   // untouched import: replaced by the new version
  assert.ok(isPristineSeed(db.batches['seed-b1-prep']));
  assert.equal(db.batches['seed-b2-prep'].name, 'edited by me');         // edit kept ...
  assert.deepEqual(db.batches['seed-b2-prep'].links, ['seed-b2-hyb']);   // ... and it gained its link
  assert.deepEqual(db.batches['seed-b3-prep'].links, ['somewhere-else']); // its own links win
  assert.equal(db.settings.seedVersion, seed.version);
});

test('wells read as ranges in fill order', () => {
  assert.equal(wellRanges(['D1', 'D2', 'D3', 'E1']), 'D1–D3, E1');
  assert.equal(wellRanges(['A12', 'B1']), 'A12–B1');
  assert.equal(wellRanges(['H6', 'B7', 'B8', 'C1', 'H5']), 'B7–B8, C1, H5–H6');
  assert.equal(wellRanges([]), '');
  assert.equal(wellRanges(['A1', 'B1', 'C1'], 'col'), 'A1–C1');
});
