import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildBackup, parseBackup, mergeBackup, mergePlan, canAutosave, backupStatus, daysSince, isSafeId } from '../src/backup.js';
import {
  getPath, setPath, parseDuration, durationText, makeDefault, blankProtocol, duplicateProtocol, newProtocolId,
  validateProtocol, normalizeProtocol, clone,
} from '../src/protocol_edit.js';
import { flattenProtocol } from '../src/calc.js';

const load = id => JSON.parse(readFileSync(new URL(`../protocols/${id}.json`, import.meta.url)));
const kapa = load('kapa_rna_hyperprep');
const xgen = load('xgen_hyb_wash_v3');
const batch = (id, name) => ({ id, name, n: 8, overagePct: 10, protocol: kapa, state: {}, plate: { samples: [] } });
const mkdb = () => ({ batches: {}, plates: {}, protocols: {}, settings: { deleted: {}, qc: { concMin: 5 } } });

/* ---------- backup ---------- */
test('a backup round-trips through text', () => {
  const db = mkdb();
  db.batches.a = batch('a', 'one');
  db.plates.p1 = { id: 'p1', name: 'plate', flags: { D1: 'low' } };
  const back = parseBackup(JSON.stringify(buildBackup(db)));
  assert.deepEqual(Object.keys(back.batches), ['a']);
  assert.equal(back.plates.p1.flags.D1, 'low');
});

test('parseBackup rejects things that are not backups, in plain words', () => {
  assert.throws(() => parseBackup('nope'), /not a JSON file/);
  assert.throws(() => parseBackup('{"a":1}'), /not a benchbook backup/);
  assert.throws(() => parseBackup(JSON.stringify({ format: 'benchbook-backup', batches: { x: { name: 'x' } } })), /batch "x" is damaged/);
});

test('mergeBackup adds missing, keeps existing, overwrites only when asked', () => {
  const db = mkdb();
  db.batches.keep = { ...batch('keep', 'local version'), marker: 1 };
  db.plates.p1 = { id: 'p1', name: 'plate', flags: { D1: 'mine' } };
  const backup = {
    batches: { keep: batch('keep', 'file version'), fresh: batch('fresh', 'new') },
    protocols: { mine: { id: 'mine', name: 'x' } },
    plates: { p1: { id: 'p1', name: 'plate', flags: { D1: 'theirs', E2: 'other' } } },
    deleted: {},
  };
  const plan = mergePlan(db, backup);
  assert.deepEqual([plan.newBatches, plan.clashBatches], [['fresh'], ['keep']]);
  const res = mergeBackup(db, backup);
  assert.deepEqual(res, { added: 2, overwritten: 0, skipped: 1 });
  assert.equal(db.batches.keep.name, 'local version');
  assert.deepEqual(db.plates.p1.flags, { D1: 'mine', E2: 'other' }); // local reason wins, missing flags are added
  const res2 = mergeBackup(db, backup, { overwrite: true });
  assert.equal(res2.overwritten, 3);
  assert.equal(db.batches.keep.name, 'file version');
});

test('canAutosave refuses to overwrite a file that holds data this browser lacks', () => {
  const db = mkdb();
  assert.equal(canAutosave(null, db).ok, true);
  const file = { batches: { a: batch('a', 'a'), b: batch('b', 'b') }, protocols: { p: { id: 'p' } } };
  const empty = canAutosave(file, db);
  assert.equal(empty.ok, false);
  assert.deepEqual(empty.missing, ['a', 'b', 'p']);
  db.batches.a = batch('a', 'a'); db.batches.b = batch('b', 'b'); db.protocols.p = { id: 'p' };
  assert.equal(canAutosave(file, db).ok, true);
  delete db.batches.b; // removed on purpose
  assert.equal(canAutosave(file, db).ok, false);
  db.settings.deleted.b = '2026-01-01';
  assert.equal(canAutosave(file, db).ok, true);
});

test('merging a backup clears the "deleted" mark for what it restores', () => {
  const db = mkdb();
  db.settings.deleted.a = 'x';
  mergeBackup(db, { batches: { a: batch('a', 'a') }, protocols: {}, plates: {}, deleted: {} });
  assert.equal(db.settings.deleted.a, undefined);
});

test('the backup chip tells the truth about the safety net', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  assert.equal(backupStatus({ folder: { status: 'ok', lastSaved: now }, hasData: true, now }).level, 'ok');
  assert.equal(backupStatus({ folder: { status: 'conflict' }, hasData: true, now }).level, 'warn');
  assert.equal(backupStatus({ folder: { status: 'error', message: 'x' }, hasData: true, now }).level, 'bad');
  assert.equal(backupStatus({ folder: { status: 'off' }, hasData: false, now }).level, 'none');
  assert.equal(backupStatus({ folder: { status: 'off' }, hasData: true, now }).text, 'Not backed up');
  assert.match(backupStatus({ folder: { status: 'off' }, hasData: true, lastExport: '2026-11-01T12:00:00Z', now }).text, /9 days/);
  assert.match(backupStatus({ folder: { status: 'off' }, hasData: true, lastExport: '2026-11-09T12:00:00Z', now }).text, /1d ago/);
  assert.equal(daysSince(null), null);
});

/* ---------- protocol editing ---------- */
test('the shipped protocols pass the editor validator', () => {
  assert.deepEqual(validateProtocol(kapa), []);
  assert.deepEqual(validateProtocol(xgen), []);
});

test('normalising a shipped protocol changes nothing that matters', () => {
  for (const p of [kapa, xgen]) {
    const n = normalizeProtocol(p);
    assert.deepEqual(flattenProtocol(n).map(i => i.key), flattenProtocol(p).map(i => i.key));
    assert.deepEqual(validateProtocol(n), []);
    assert.equal(JSON.stringify(n.sections), JSON.stringify(p.sections)); // holds (null duration) survive
  }
});

test('paths: get, set, create parents, remove', () => {
  const o = { a: [{ b: 1 }] };
  assert.equal(getPath(o, 'a.0.b'), 1);
  setPath(o, 'a.0.c.d', 5);
  assert.equal(o.a[0].c.d, 5);
  setPath(o, 'a.0.b', undefined);
  assert.equal('b' in o.a[0], false);
});

test('durations: units, holds, and rejects', () => {
  assert.deepEqual(parseDuration('45 s'), { ok: true, value: 45 });
  assert.deepEqual(parseDuration('10 min'), { ok: true, value: 600 });
  assert.deepEqual(parseDuration('1.5 h'), { ok: true, value: 5400 });
  assert.deepEqual(parseDuration('hold'), { ok: true, value: null });
  assert.deepEqual(parseDuration(''), { ok: true, value: null });
  assert.equal(parseDuration('10').ok, false); // a bare number is ambiguous
  assert.equal(parseDuration('soon').ok, false);
  assert.equal(durationText(600), '10 min');
  assert.equal(durationText(45), '45 s');
  assert.equal(durationText(7200), '2 h');
  assert.equal(durationText(null), 'hold');
});

test('a new protocol starts invalid only where the person must fill something in', () => {
  const p = blankProtocol(new Set());
  assert.deepEqual(validateProtocol(p), ['Section 1 "1. First section", step 1: needs text']);
  p.sections[0].steps[0].text = 'Do the thing';
  assert.deepEqual(validateProtocol(p), []);
});

test('new steps are flagged until filled in, with readable messages', () => {
  const p = blankProtocol(new Set());
  p.sections[0].steps = [makeDefault('mix'), makeDefault('thermocycle'), makeDefault('cleanup')];
  p.sections[0].steps[1].program[0].duration_s = 'x';
  const errs = validateProtocol(p);
  assert.ok(errs.some(e => /step 1 "New master mix": component 1 needs a name/.test(e)));
  assert.ok(errs.some(e => /component 1 needs a volume above 0/.test(e)));
  assert.ok(errs.some(e => /row 1: needs a name/.test(e)));
  assert.ok(errs.some(e => /needs a time like/.test(e)));
  assert.equal(errs.some(e => /Bead cleanup/.test(e)), false); // the cleanup default is complete
});

test('validation catches the real mistakes a person could make', () => {
  const p = clone(kapa);
  p.name = ' ';
  p.default_overage_pct = 80;
  p.sections[0].steps[1].program[0].temp_c = 300;
  p.sections[5].steps[1].program[1].cycles = 0;
  p.sections[2].steps[0].dispense_vol = -3;
  const errs = validateProtocol(p).join('\n');
  assert.match(errs, /Protocol: needs a name/);
  assert.match(errs, /overage must be between 0 and 50/);
  assert.match(errs, /temperature between 0 and 110/);
  assert.match(errs, /cycle count must be a whole number/);
  assert.match(errs, /dispense volume must be above 0/);
});

test('normalising strips empty optional fields and an unnamed sample input', () => {
  const p = clone(kapa);
  const mix = p.sections[0].steps[0];
  mix.input = { name: '', vol: 10, note: '' };
  mix.note = '   ';
  mix.dispense_vol = undefined;
  mix.add = [];
  const n = normalizeProtocol(p).sections[0].steps[0];
  assert.equal(n.input, undefined);
  assert.equal('note' in n, false);
  assert.equal('add' in n, false);
  assert.equal(n.components.length, 3);
});

test('duplicating gives a new, unique id and tracks where it came from', () => {
  const d = duplicateProtocol(kapa, new Set(['kapa_rna_hyperprep', 'kapa_rna_hyperprep_cotton_copy']));
  assert.equal(d.based_on, 'kapa_rna_hyperprep');
  assert.equal(d.name, `${kapa.name} (copy)`);
  assert.equal(d.custom, true);
  assert.equal(d.revision, 1);
  assert.notEqual(d.id, kapa.id);
  assert.equal(newProtocolId('A b', new Set(['a_b'])), 'a_b_2');
  assert.notEqual(d.sections, kapa.sections); // deep copy
});

/* ---------- a backup file is untrusted input ---------- */
const file = (extra = {}) => JSON.stringify({ format: 'benchbook-backup', batches: { a: batch('a', 'A') }, plates: {}, protocols: {}, ...extra });
const rejects = (text, re) => assert.throws(() => parseBackup(text), re);

test('a backup with ids that could carry markup is refused', () => {
  const evil = '"><img src=x onerror=alert(1)>';
  rejects(file({ batches: { [evil]: batch(evil, 'x') } }), /unusable id/);
  rejects(file({ batches: { a: { ...batch('a', 'A'), id: 'b' } } }), /unusable id/); // key and id disagree
  rejects(file({ batches: { a: { ...batch('a', 'A'), links: [evil] } } }), /damaged links/);
  rejects(file({ plates: { [evil]: { id: evil, flags: {} } } }), /index plate/);
  rejects(file({ protocols: { [evil]: { id: evil } } }), /protocol/);
});

test('names that exist on every object are not accepted as ids', () => {
  for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) assert.equal(isSafeId(id), false, id);
  rejects('{"format":"benchbook-backup","batches":{"__proto__":{"id":"__proto__","name":"x","n":1,"overagePct":0,"protocol":{},"state":{}}}}', /unusable id/);
});

test('counts must be numbers in range', () => {
  rejects(file({ batches: { a: { ...batch('a', 'A'), n: '5<b>' } } }), /reaction count/);
  rejects(file({ batches: { a: { ...batch('a', 'A'), n: 0 } } }), /reaction count/);
  rejects(file({ batches: { a: { ...batch('a', 'A'), overagePct: 'ten' } } }), /overage/);
  rejects(file({ batches: [batch('a', 'A')] }), /damaged/);
});

test('every id this app makes itself is accepted', () => {
  for (const id of ['seed-b5-hyb', 'seed-udi-plate', 'bmfq1abc', 'i1x2y3z', 'kapa_rna_hyperprep_2', 'q-b5-pre', 'p1abc']) assert.ok(isSafeId(id), id);
});
