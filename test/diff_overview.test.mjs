import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { diffProtocols, diffBatches } from '../src/diff.js';
import { qcLabels, series, median, libraryQcSet, libraryBars, previousBatch, batchDate } from '../src/overview.js';
import { summarize, DEFAULT_THRESHOLDS as THR } from '../src/qc.js';
import { newBatch } from '../src/calc.js';
import { defaultPlate } from '../src/plate.js';

const kapa = JSON.parse(readFileSync(new URL('../protocols/kapa_rna_hyperprep.json', import.meta.url)));
const clone = x => JSON.parse(JSON.stringify(x));

function mk(id, name, { protocol = kapa, prep = '', sets = [] } = {}) {
  const b = newBatch(protocol, { name, n: 24, overagePct: 10, id });
  b.created = '2026-10-01T00:00:00.000Z';
  b.info.prep = prep;
  b.qc = { sets };
  b.plate = defaultPlate();
  return b;
}
const set = (id, label, concs) => ({ id, label, rows: concs.map((c, i) => ({ name: `L${i + 1}`, conc: c, r280: 1.85, r230: 2.0 })) });

/* ---------- compare ---------- */
test('identical protocols have no differences', () => {
  assert.deepEqual(diffProtocols(kapa, clone(kapa)), []);
});

test('the diff names every kind of change in plain words', () => {
  const b = clone(kapa);
  b.default_overage_pct = 5;
  b.sections[0].steps[0].components[1].vol = 10;
  b.sections[0].steps[0].components.push({ name: 'RNase inhibitor', vol: 0.5 });
  b.sections[0].steps[1].program[1].duration_s = 2400;
  b.sections[5].steps[1].program[1].cycles = 14;
  b.sections[2].steps[1].note = 'Ligation can be 15 min.';
  b.sections[4].steps[0].dry_min = 4;
  b.sections[6].steps.splice(0, 1);
  const text = diffProtocols(kapa, b).map(d => d.text);
  assert.ok(text.includes('Protocol: default overage 10 % → 5 %'), text.join('\n'));
  assert.ok(text.some(t => t.includes('"1st strand synthesis buffer" volume 9.17 µL → 10 µL')));
  assert.ok(text.some(t => t.includes('added component "RNase inhibitor" (0.5 µL)')));
  assert.ok(text.some(t => t.includes('"1st strand synthesis" time 30 min → 40 min')));
  assert.ok(text.some(t => t.includes('repeat group 1 cycles 16 → 14')));
  assert.ok(text.some(t => t.includes('note "Ligation can be as short as 15 min." → "Ligation can be 15 min."')));
  assert.ok(text.some(t => t.includes('dry time 3 min → 4 min')));
  assert.ok(text.some(t => t.includes('removed step "KAPA Pure Beads cleanup"')));
});

test('the diff is not fooled by inserting a step earlier in a section', () => {
  const b = clone(kapa);
  b.sections[0].steps.unshift({ type: 'step', text: 'Thaw everything on ice.' });
  assert.deepEqual(diffProtocols(kapa, b).map(d => d.text), ['1. First strand synthesis: added step "Thaw everything on ice."']);
});

test('the diff finds a removed or added section and a changed cleanup', () => {
  const b = clone(kapa);
  b.sections.pop();
  b.sections.push({ title: '8. Extra', steps: [{ type: 'step', text: 'x' }] });
  b.sections[4].steps[0].elute_vol = 25;
  const text = diffProtocols(kapa, b).map(d => d.text);
  assert.ok(text.includes('Protocol: removed section "7. Cleanup 2"'));
  assert.ok(text.includes('Protocol: added section "8. Extra"'));
  assert.ok(text.some(t => t.includes('elution volume 21 µL → 25 µL')));
});

test('a batch diff covers settings, protocol, notes and QC', () => {
  const a = mk('a', 'one', { sets: [set('q1', 'Pre-capture libraries', [100, 200, 300])] });
  const p2 = clone(kapa); p2.revision = 2; p2.sections[0].steps[0].components[0].vol = 12;
  const b = mk('b', 'two', { protocol: p2, sets: [set('q2', 'Pre-capture libraries', [50, 60, 4])] });
  b.overagePct = 5;
  b.state['0.0'] = { notes: [{ tag: 'deviation', text: 'x', t: '1' }] };
  const d = diffBatches(a, b, { summarizeSet: rows => summarize(rows, THR) });
  assert.equal(d.settings.find(r => r.label === 'Master-mix overage').changed, true);
  assert.equal(d.settings.find(r => r.label === 'Protocol revision').b, '2');
  assert.equal(d.settings.find(r => r.label === 'Count').changed, false);
  assert.equal(d.protocol.length, 1);
  assert.deepEqual(d.notes.b.counts, { deviation: 1 });
  assert.equal(d.qc[0].a.median, 200);
  assert.equal(d.qc[0].b.flagged, 1);
});

test('a QC label only one batch has shows as not measured in the other', () => {
  const a = mk('a', 'one', { sets: [set('q1', 'RNA input', [10])] });
  const b = mk('b', 'two', { sets: [set('q2', 'Pre-capture libraries', [100])] });
  const d = diffBatches(a, b, { summarizeSet: rows => summarize(rows, THR) });
  assert.deepEqual(d.qc.map(q => [q.label, q.a === null, q.b === null]), [['RNA input', false, true], ['Pre-capture libraries', true, false]]);
});

/* ---------- graphs ---------- */
test('previousBatch prefers the same protocol and respects dates', () => {
  const other = clone(kapa); other.id = 'other';
  const a = mk('a', 'A', { prep: '2026-10-01' });
  const x = mk('x', 'X', { prep: '2026-10-05', protocol: other });
  const b = mk('b', 'B', { prep: '2026-10-10' });
  assert.equal(previousBatch({ a, x, b }, b).id, 'a');
  assert.equal(previousBatch({ a, x, b }, a), null);
  assert.equal(batchDate(a), '2026-10-01T12:00:00');
});

test('series: ordered by date, medians, flagged points and protocol-change markers', () => {
  const p2 = clone(kapa); p2.revision = 2;
  const a = mk('a', 'A', { prep: '2026-10-01', sets: [set('q', 'Pre-capture libraries', [100, 200, 3])] });
  const b = mk('b', 'B', { prep: '2026-10-10', protocol: p2, sets: [set('q', 'Pre-capture libraries', [150, 250])] });
  const c = mk('c', 'C', { prep: '2026-10-05', sets: [set('q', 'Other', [1])] });
  const s = series({ b, a, c }, 'Pre-capture libraries', 'conc', THR);
  assert.deepEqual(s.map(x => x.id), ['a', 'b']);
  assert.equal(s[0].median, 100);
  assert.equal(s[0].points.filter(p => p.flagged).length, 1);
  assert.equal(s[0].newProtocol, false);
  assert.equal(s[1].newProtocol, true);
  assert.deepEqual(qcLabels({ a, b, c }), [{ label: 'Pre-capture libraries', batches: 2 }, { label: 'Other', batches: 1 }]);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([]), null);
});

test('per-library bars carry value, flag and pool, matched by name', () => {
  const a = mk('a', 'A', { sets: [set('r', 'RNA input', [10, 20]), set('q', 'Pre-capture libraries', [100, 4, 300])] });
  a.plate = { ...defaultPlate(), qcSetId: 'q', samples: [{ name: 'L1', well: 'D1', pool: 1 }, { name: 'l2', well: 'D2', pool: 1 }, { name: 'L3', well: 'D3', pool: 2 }] };
  assert.equal(libraryQcSet(a).id, 'q');
  const { set: s, bars } = libraryBars(a, null, 'conc', THR);
  assert.equal(s.id, 'q');
  assert.deepEqual(bars.map(x => [x.name, x.v, x.flagged, x.pool]), [['L1', 100, false, 1], ['L2', 4, true, 1], ['L3', 300, false, 2]]);
  assert.equal(libraryBars(a, 'r', 'conc', THR).bars.length, 2);                 // another set on request
  assert.equal(libraryBars(a, 'q', 'r280', THR).bars.every(x => !x.flagged), true);
  assert.equal(libraryBars(mk('e', 'E'), null, 'conc', THR).set, null);          // no QC yet
});
