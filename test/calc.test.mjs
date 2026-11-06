import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fmt, fmtDuration, mixTable, programSeconds, flattenProtocol, newBatch, collectNotes, progress } from '../src/calc.js';

const load = id => JSON.parse(readFileSync(new URL(`../protocols/${id}.json`, import.meta.url)));
const kapa = load('kapa_rna_hyperprep');
const xgen = load('xgen_hyb_wash_v3');
const firstMix = kapa.sections[0].steps[0];

test('master mix matches the lab workbook (24 rxn, +10%)', () => {
  const t = mixTable(firstMix, 24, 10);
  assert.equal(fmt(t.mmRows[0].total), '264');
  assert.equal(fmt(t.mmRows[1].total, 1), '242');
  assert.equal(fmt(t.mmRows[2].total, 1), '22');
  assert.equal(fmt(t.dispense), '20');
  assert.equal(fmt(t.finalVol), '30');
});

test('overage is applied to master-mixed rows only', () => {
  const t = mixTable(kapa.sections[2].steps[0], 24, 5);
  assert.equal(fmt(t.mmRows[0].total), '916.27'); // 36.36 x 24 x 1.05
  assert.equal(t.addRows[0].total, 5 * 24); // adapter: no overage
  assert.equal(t.dispense, 45); // explicit dispense override
  assert.equal(t.finalVol, 110); // 60 + 45 + 5
});

test('a step with no master mix has no dispense', () => {
  const user = mixTable(kapa.sections[3].steps[0], 24, 10);
  assert.equal(user.dispense, null);
  assert.equal(user.finalVol, 114); // 110 + 4
});

test('dispense:false suppresses dispense (wash buffer prep)', () => {
  const wb = xgen.sections[2].steps[0];
  assert.equal(mixTable(wb, 8, 10).dispense, null);
});

test('program run time expands cycles and ignores open holds', () => {
  const pcr = kapa.sections[5].steps[1].program;
  assert.equal(programSeconds(pcr), 45 + 16 * (15 + 30 + 30) + 60);
  assert.equal(programSeconds(kapa.sections[0].steps[1].program), 600 + 1800 + 900);
});

test('durations read well', () => {
  assert.equal(fmtDuration(null), '∞');
  assert.equal(fmtDuration(45), '45 s');
  assert.equal(fmtDuration(600), '10 min');
  assert.equal(fmtDuration(3900), '1 h 5 min');
  assert.equal(fmtDuration(7200), '2 h');
});

test('cleanups expand into five ticked steps with stable unique keys', () => {
  for (const p of [kapa, xgen]) {
    const items = flattenProtocol(p);
    const keys = items.map(i => i.key);
    assert.equal(new Set(keys).size, keys.length);
  }
  const items = flattenProtocol(kapa);
  const bind = items.filter(i => i.step.timer_min === 30);
  assert.ok(bind.length >= 2);
});

test('batches snapshot the protocol and collect notes in step order', () => {
  const b = newBatch(kapa, { name: 't', n: 24, overagePct: 5 });
  const items = flattenProtocol(kapa);
  b.state[items[3].key] = { done: '2026-01-01T00:00:00Z', notes: [{ t: 'x', tag: 'deviation', text: 'late' }] };
  b.state[items[1].key] = { notes: [{ t: 'y', tag: 'idea', text: 'try' }] };
  assert.equal(collectNotes(b, items).map(n => n.text).join(), 'try,late');
  assert.deepEqual(progress(b, items), { done: 1, total: items.length });
  assert.notEqual(b.protocol, undefined);
});
