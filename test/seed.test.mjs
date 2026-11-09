import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applySeed, hydrateBatch, isPristineSeed, fingerprint } from '../src/seed.js';
import { ensureBatch } from '../src/shared.js';
import { flattenProtocol, expandCleanup } from '../src/calc.js';
import { validateProtocol } from '../src/protocol_edit.js';
import { diffBatches } from '../src/diff.js';
import { canAutosave, mergeBackup, mergePlan } from '../src/backup.js';
import { summarize, DEFAULT_THRESHOLDS as THR } from '../src/qc.js';
import { poolPlan } from '../src/plate.js';

const seed = JSON.parse(readFileSync(new URL('../data/seed.json', import.meta.url)));
const mkdb = () => ({ batches: {}, plates: {}, protocols: {}, settings: { deleted: {}, qc: { ...THR } } });
const hydrated = id => hydrateBatch(seed, seed.batches.find(b => b.id === id), ensureBatch);
const conc = (b, i = 0) => b.qc.sets[i].rows.map(r => r.conc);

/* ---------- the data itself ---------- */
test('the seed holds the workbook: 8 library-prep batches and 6 hyb and capture batches', () => {
  assert.equal(seed.batches.length, 14);
  assert.equal(new Set(seed.batches.map(b => b.id)).size, 14);
  assert.equal(seed.batches.filter(b => b.id.endsWith('-prep')).length, 8);
  assert.equal(seed.batches.filter(b => b.id.endsWith('-hyb')).length, 6);
});

test('every protocol variant is valid and every tick and note sits on a step that exists', () => {
  for (const [id, p] of Object.entries(seed.protocols)) assert.deepEqual(validateProtocol(p), [], id);
  for (const b of seed.batches) {
    const keys = new Set(flattenProtocol(seed.protocols[b.protocol]).map(i => i.key));
    for (const k of Object.keys(b.state)) assert.ok(keys.has(k), `${b.name}: ${k}`);
  }
});

test('dates run in order: prep, hyb, capture, sequencing; stale dates are left out', () => {
  for (const b of seed.batches) {
    const { prep, hyb, cap, seq } = b.info;
    const given = [prep, hyb, cap, seq].filter(Boolean);
    assert.deepEqual(given, [...given].sort(), b.name);
  }
  const b6 = seed.batches.find(b => b.id === 'seed-b6-prep');
  assert.deepEqual([b6.info.hyb, b6.info.cap, b6.info.seq], ['', '', '']);   // copied forward from an older tab
  assert.equal(seed.batches.find(b => b.id === 'seed-b3-hyb').info.seq, ''); // "2609XX" in the workbook
});

test('batch 6 is planned, not run: nothing ticked, and no readings copied from another tab', () => {
  const b6 = seed.batches.find(b => b.id === 'seed-b6-prep');
  assert.equal(Object.values(b6.state).filter(s => s.done).length, 0);
  assert.equal(b6.qc.sets.length, 0);
});

test('readings are exactly the workbook values', () => {
  const b5 = hydrated('seed-b5-prep');
  assert.deepEqual(conc(b5), [229.0, 322.2, 112.8, 232.9, 205.9, 198.4, 128.9, 98.7, 262.2, 191.0, 298.8, 372.3, 485.6, 220.4, 229.3, 132.0, 465.4, 406.4, 287.7, 528.6, 506.7, 405.3, 169.1, 333.0]);
  const b1 = hydrated('seed-b1-prep');
  assert.equal(b1.qc.sets[0].rows.length, 24);                 // preR23 was read twice to check for a bubble: one library, not two
  assert.ok(!b1.qc.sets[0].rows.some(r => /_2$/.test(r.name)));
  assert.equal(b1.qc.sets[0].rows[22].name, 'preR23');
  assert.equal(b1.qc.sets[0].rows[22].conc, 18.7);             // the first reading is the one used
  assert.ok(b1.qc.sets[0].warnings.some(w => /preR23 was read twice \(18\.7 and 18\.5/.test(w)));
  const replicateNote = Object.values(b1.state).flatMap(x => x.notes).find(n => /read twice/.test(n.text));
  assert.match(replicateNote.text, /second reading matched the first/);
  assert.equal(b1.qc.sets[0].rows[0].name, 'preR1');
  assert.equal(b1.qc.sets[0].rows[0].conc, 68.8);
  assert.equal(hydrated('seed-rnaiso-prep').qc.sets[0].rows.length, 12);
  assert.equal(hydrated('seed-b4-hyb').qc.sets[0].rows.length, 8);
});

test('batch 4 carries only its NanoDrop readings; the Qubit comparison is left behind', () => {
  const b4 = hydrated('seed-b4-prep');
  assert.deepEqual(b4.qc.sets.map(s => s.label), ['Pre-capture libraries']);
  assert.equal(b4.qc.sets[0].rows.length, 24);
  assert.deepEqual(conc(b4).slice(0, 4), [222.3, 111.9, 163.7, 358.2]);
  assert.equal(JSON.stringify(seed).includes('Qubit'), false);
});

test('UDI wells: batch 1 D1-E12, batch 2 F1-G12, DNase screen A1-B6, no overlaps', () => {
  const wells = id => hydrated(id).plate.samples.map(s => s.well);
  assert.deepEqual([wells('seed-b1-prep')[0], wells('seed-b1-prep')[23]], ['D1', 'E12']);
  assert.deepEqual([wells('seed-b2-prep')[0], wells('seed-b2-prep')[23]], ['F1', 'G12']);
  assert.deepEqual([wells('seed-dnase-prep')[0], wells('seed-dnase-prep')[17]], ['A1', 'B6']);
  const all = ['seed-b1-prep', 'seed-b2-prep', 'seed-dnase-prep'].flatMap(wells);
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual(Object.keys(seed.plates['seed-udi-plate'].flags), ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8']);
});

test('pooling plans from the real readings need no more than the available volume', () => {
  for (const id of ['seed-b1-prep', 'seed-b2-prep', 'seed-b5-prep']) {
    const b = hydrated(id);
    const plan = poolPlan(b.plate.samples, b.qc.sets.find(s => s.id === b.plate.qcSetId).rows, { targetNg: b.plate.targetNg, availUl: b.plate.availUl });
    assert.equal(plan.length, 8, id);
    assert.ok(plan.every(p => p.missing.length === 0), id);
  }
  assert.equal(poolPlan(hydrated('seed-dnase-prep').plate.samples, hydrated('seed-dnase-prep').qc.sets[0].rows, { targetNg: 1000, availUl: 20 }).length, 3);
});

test('the duplicate sample ID in hyb batch 2 is kept and flagged (pools 3 and 4 were combined)', () => {
  const b = hydrated('seed-b2-hyb');
  const names = b.qc.sets[0].rows.map(r => r.name);
  assert.equal(names.filter(n => n === 'SI_44453-58').length, 2);
  assert.ok(b.qc.sets[0].warnings.some(w => /duplicate sample names: SI_44453-58/.test(w)));
});

test('no administrative leftovers or contact details were copied', () => {
  const text = JSON.stringify(seed);
  for (const bad of [/LIMS/i, /e-?mail/i, /@/, /User ?name/i, /print[^"]*labels/i]) assert.equal(bad.test(text), false, String(bad));
});

/* ---------- protocol drift the Compare page should show ---------- */
const cmp = (a, b) => diffBatches(hydrated(a), hydrated(b), { summarizeSet: r => summarize(r, THR) });

test('batch 3 to batch 4: drying dropped, elution in 20 µL of water', () => {
  const text = cmp('seed-b3-prep', 'seed-b4-prep').protocol.map(d => d.text);
  assert.ok(text.some(t => /Cleanup 1.*dry time 3 min → 0 min/.test(t)), text.join('\n'));
  assert.ok(text.some(t => /Cleanup 2.*dry time 5 min → 0 min/.test(t)));
  assert.ok(text.some(t => /Cleanup 1.*elution volume 21 µL → 20 µL/.test(t)));
  assert.ok(text.some(t => /elution buffer none → "water"/.test(t)));
});

test('batch 4 to batch 5: the adapter is master-mixed and the dispense is 50 µL', () => {
  const text = cmp('seed-b4-prep', 'seed-b5-prep').protocol.map(d => d.text);
  assert.ok(text.some(t => /removed per-reaction item "Adapter \(15 uM\)"/.test(t)), text.join('\n'));
  assert.ok(text.some(t => /added component "Adapter \(15 uM\)" \(5 µL\)/.test(t)));
  assert.ok(text.some(t => /dispense volume 45 µL → 50 µL/.test(t)));
});

test('batches 1 to 3 used the same protocol numbers (only the overage setting moved)', () => {
  assert.equal(cmp('seed-b1-prep', 'seed-b3-prep').protocol.length, 0);
  assert.equal(cmp('seed-b1-prep', 'seed-b2-prep').settings.find(r => r.label === 'Master-mix overage').changed, true);
});

test('cleanup text follows the data: no drying, elution buffer', () => {
  const steps = expandCleanup({ title: 't', sample: 's', sample_vol: 1, bead: 'b', bead_vol: 1, bind_min: 5, wash: 'w', dry_min: 0, elute_vol: 20, elute_min: 5, transfer_vol: 20, elute_buffer: 'water' });
  assert.match(steps[2].text, /No drying/);
  assert.match(steps[3].text, /Elute in 20 µL water\./);
  const old = expandCleanup({ title: 't', sample: 's', sample_vol: 1, bead: 'b', bead_vol: 1, bind_min: 5, wash: 'w', dry_min: 3, elute_vol: 21, elute_min: 5, transfer_vol: 20 });
  assert.match(old[2].text, /Air-dry/);
  assert.match(old[3].text, /Tris \(5 mM\) or water/);
});

/* ---------- loading, editing and backing up the seed ---------- */
test('seeding adds every batch once, is idempotent, and never touches an edited batch', () => {
  const db = mkdb();
  assert.equal(applySeed(db, seed, { ensure: ensureBatch }), 14);
  assert.equal(applySeed(db, seed, { ensure: ensureBatch }), 0);
  assert.ok(Object.values(db.batches).every(isPristineSeed));
  db.batches['seed-b1-prep'].name = 'my edit';
  assert.equal(isPristineSeed(db.batches['seed-b1-prep']), false);
  assert.equal(applySeed(db, seed, { force: true, ensure: ensureBatch }), 0);
  assert.equal(db.batches['seed-b1-prep'].name, 'my edit');
});

test('a batch you deleted stays deleted, until you ask to restore it', () => {
  const db = mkdb();
  applySeed(db, seed, { ensure: ensureBatch });
  delete db.batches['seed-b2-prep'];
  db.settings.deleted['seed-b2-prep'] = 'x';
  db.settings.seedVersion = 0; // pretend the seed changed
  assert.equal(applySeed(db, seed, { ensure: ensureBatch }), 0);
  assert.equal(applySeed(db, seed, { force: true, ensure: ensureBatch }), 1);
  assert.ok(db.batches['seed-b2-prep']);
});

test('ticking a step or adding a note makes a seeded batch "edited"; the fingerprint notices', () => {
  const b = hydrated('seed-b3-prep');
  assert.equal(isPristineSeed(b), true);
  b.state['0.0'] = { ...(b.state['0.0'] || { notes: [] }), notes: [...(b.state['0.0']?.notes || []), { t: 'x', tag: 'idea', text: 'new' }] };
  assert.equal(isPristineSeed(b), false);
  assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }));
});

test('a backup folder holding your edited seed batch is never overwritten by a fresh pristine copy', () => {
  const edited = hydrated('seed-b1-prep');
  edited.name = 'edited in an earlier browser';
  const file = { batches: { 'seed-b1-prep': edited }, protocols: {}, plates: {}, deleted: {} };
  const fresh = mkdb();
  applySeed(fresh, seed, { ensure: ensureBatch });
  const c = canAutosave(file, fresh);
  assert.equal(c.ok, false);
  assert.deepEqual(c.missing, ['seed-b1-prep']);
  // restoring replaces the pristine copy with the edited one, silently
  assert.deepEqual(mergePlan(fresh, file).newBatches, ['seed-b1-prep']);
  assert.deepEqual(mergeBackup(fresh, file), { added: 1, overwritten: 0, skipped: 0 });
  assert.equal(fresh.batches['seed-b1-prep'].name, 'edited in an earlier browser');
  assert.equal(canAutosave(file, fresh).ok, true);
});

test('pristine copies on both sides are not a conflict, and an edited local batch is never replaced', () => {
  const fresh = mkdb(); applySeed(fresh, seed, { ensure: ensureBatch });
  const same = { batches: { 'seed-b1-prep': hydrated('seed-b1-prep') }, protocols: {}, plates: {}, deleted: {} };
  assert.equal(canAutosave(same, fresh).ok, true);
  fresh.batches['seed-b1-prep'].name = 'edited here';
  const other = { batches: { 'seed-b1-prep': { ...hydrated('seed-b1-prep'), name: 'edited elsewhere' } }, protocols: {}, plates: {}, deleted: {} };
  assert.deepEqual(mergeBackup(fresh, other), { added: 0, overwritten: 0, skipped: 1 });
  assert.equal(fresh.batches['seed-b1-prep'].name, 'edited here');
});

test('a newer seed corrects seeded readings in an edited batch and leaves everything else alone', () => {
  const db = mkdb();
  applySeed(db, seed, { ensure: ensureBatch });
  const b = db.batches['seed-b4-prep'];
  // what an older seed left behind: two Qubit sets, which the current seed no longer has
  b.qc.sets.push({ id: 'q-b4-hs', label: 'Pre-capture libraries (Qubit HS)', rows: [{ name: 'x', conc: 1 }], warnings: [] });
  b.qc.sets.push({ id: 'q-b4-br', label: 'Pre-capture libraries (Qubit BR)', rows: [{ name: 'x', conc: 2 }], warnings: [] });
  b.qc.sets.push({ id: 'qmy1abc', label: 'my own paste', rows: [{ name: 'mine', conc: 3 }], warnings: [] });   // pasted by the person
  b.qc.sets[0].rows[0].conc = 999;                                                                          // a stale seeded reading
  b.plate.name = 'kept';
  b.state['0.0'] = { done: '2026-10-01', timer: null, notes: [{ t: 'x', tag: 'idea', text: 'my note' }] };
  db.settings.seedVersion = 2;
  applySeed(db, seed, { ensure: ensureBatch });
  assert.deepEqual(b.qc.sets.map(x => x.id), ['q-b4-nd', 'qmy1abc']);          // Qubit sets gone, mine kept
  assert.equal(b.qc.sets[0].rows[0].conc, 222.3);                              // seeded reading corrected
  assert.equal(b.state['0.0'].notes[0].text, 'my note');                       // edits untouched
  assert.equal(b.state['0.0'].done, '2026-10-01');
  assert.equal(b.plate.qcSetId, 'q-b4-nd');
});

test('a seeded set you deleted on purpose does not come back with a newer seed', () => {
  const db = mkdb();
  applySeed(db, seed, { ensure: ensureBatch });
  const b = db.batches['seed-b5-prep'];
  b.qc.sets = [];
  b.plate.qcSetId = null;
  b.name = 'edited';
  db.settings.seedVersion = 2;
  applySeed(db, seed, { ensure: ensureBatch });
  assert.equal(b.qc.sets.length, 0);
});
