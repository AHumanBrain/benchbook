import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQC, flagRow, summarize, DEFAULT_THRESHOLDS } from '../src/qc.js';
import { parseWell, wellOrder, assignWells, autoPool, plateUses, plateIssues, poolPlan, plateMapCsv, defaultPlate } from '../src/plate.js';

const NANODROP = [
  ['#', 'Sample ID', 'User name', 'Date and Time', 'Nucleic Acid', 'Unit', 'A260 (Abs)', 'A280 (Abs)', '260/280', '260/230', 'Sample Type', 'Factor'],
  ['1', 'S1-3', 'User', '2026-08-12 15:07:28', '58', 'ng/µl', '1.159', '0.683', '1.7', '1.62', 'DNA', '50'],
  ['2', 'S4-6', 'User', '2026-08-12 15:08:10', '40', 'ng/µl', '0.8', '0.467', '1.71', '1.73', 'DNA', '50'],
  ['3', 'S7-9', 'User', '2026-08-12 15:09:30', '46.1', 'ng/µl', '0.922', '0.52', '1.77', '1.48', 'DNA', '50'],
  ['4', 'S10-12', 'User', '2026-08-12 15:11:53', '3.2', 'ng/µl', '0.064', '0.04', '2.3', '1.9', 'DNA', '50'],
].map(r => r.join('\t')).join('\n');

test('parses a spreadsheet-pasted NanoDrop table', () => {
  const { rows, format, warnings } = parseQC(NANODROP);
  assert.equal(format, 'nanodrop');
  assert.deepEqual(warnings, []);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].name, 'S1-3');
  assert.equal(rows[0].conc, 58);
  assert.equal(rows[0].r280, 1.7);
  assert.equal(rows[2].r230, 1.48);
});

test('flags: 1.7 passes, 1.48 260/230, low conc, high 260/280', () => {
  const { rows } = parseQC(NANODROP);
  const codes = rows.map(r => flagRow(r, DEFAULT_THRESHOLDS).map(f => f.code));
  assert.deepEqual(codes[0], []);
  assert.deepEqual(codes[1], []);
  assert.deepEqual(codes[2], ['r230-low']);
  assert.deepEqual(codes[3], ['conc-low', 'r280-high']);
  assert.equal(summarize(rows).flagged, 2);
  assert.equal(summarize(rows).median, 43.05);
});

test('parses a Qubit CSV and converts units', () => {
  const csv = 'Run ID,Assay Name,Test Name,Original sample conc.,Original sample conc. Units\nr1,dsDNA HS,libA,12.5,ng/mL\nr1,dsDNA HS,libB,"3,000",ng/mL\nr1,dsDNA HS,libC,Out of range,ng/mL\nr1,dsDNA HS,libD,8,nM';
  const { rows, format } = parseQC(csv);
  assert.equal(format, 'qubit');
  assert.equal(rows[0].conc, 0.0125);
  assert.equal(rows[2].conc, null);
  assert.equal(rows[3].conc, null);
  assert.equal(rows[3].nM, 8);
  assert.deepEqual(flagRow(rows[3]).map(f => f.code), ['no-conc']);
});

test('headerless two-column paste, with a unit warning and duplicate detection', () => {
  const { rows, warnings, format } = parseQC('libA 20\nlibB 35.5\nlibA 9');
  assert.equal(format, 'simple');
  assert.equal(rows.length, 3);
  assert.ok(warnings.some(w => w.includes('assumed')));
  assert.ok(warnings.some(w => w.includes('duplicate')));
  assert.equal(parseQC('').rows.length, 0);
});

test('wells: parsing and fill order', () => {
  assert.equal(parseWell('a01'), 'A1');
  assert.equal(parseWell('H12'), 'H12');
  assert.equal(parseWell('I1'), null);
  assert.equal(parseWell('A13'), null);
  assert.deepEqual(wellOrder('row').slice(11, 14), ['A12', 'B1', 'B2']);
  assert.deepEqual(wellOrder('col').slice(7, 10), ['H1', 'A2', 'B2']);
  assert.equal(wellOrder('row').length, 96);
});

test('assignWells: row-wise from D1 reproduces D1-E12 for 24 libraries', () => {
  const plate = { ...defaultPlate(), start: 'D1', samples: Array.from({ length: 24 }, (_, i) => ({ name: `L${i + 1}` })) };
  assert.equal(assignWells(plate, {}, new Map()), 0);
  assert.equal(plate.samples[0].well, 'D1');
  assert.equal(plate.samples[11].well, 'D12');
  assert.equal(plate.samples[12].well, 'E1');
  assert.equal(plate.samples[23].well, 'E12');
});

test('assignWells skips flagged wells and wells used by other batches', () => {
  const plate = { ...defaultPlate(), start: 'A1', samples: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] };
  const uses = new Map([['A2', { batch: 'old', sample: 'x' }]]);
  assignWells(plate, { A1: 'low volume' }, uses);
  assert.deepEqual(plate.samples.map(s => s.well), ['A3', 'A4', 'A5']);
  plate.skipFlagged = false; plate.skipUsed = false;
  assignWells(plate, { A1: 'low volume' }, uses);
  assert.deepEqual(plate.samples.map(s => s.well), ['A1', 'A2', 'A3']);
});

test('assignWells reports samples that do not fit on the plate', () => {
  const plate = { ...defaultPlate(), start: 'H11', samples: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] };
  assert.equal(assignWells(plate, {}, new Map()), 1);
  assert.equal(plate.samples[2].well, null);
});

test('plateUses finds other batches on the same plate only', () => {
  const batches = {
    one: { id: 'one', name: 'batch 1', plate: { plateId: 'p1', samples: [{ name: 'a', well: 'D1' }] } },
    two: { id: 'two', name: 'batch 2', plate: { plateId: 'p1', samples: [{ name: 'b', well: 'F1' }] } },
    three: { id: 'three', name: 'batch 3', plate: { plateId: 'p2', samples: [{ name: 'c', well: 'A1' }] } },
  };
  const uses = plateUses(batches, 'p1', 'two');
  assert.deepEqual([...uses.keys()], ['D1']);
});

test('autoPool groups consecutive samples', () => {
  assert.deepEqual(autoPool(8, 3), [1, 1, 1, 2, 2, 2, 3, 3]);
});

test('poolPlan: equal mass, then limited by the weakest library', () => {
  const samples = [1, 2, 3].map(i => ({ name: `L${i}`, pool: 1, well: `A${i}` }));
  const ok = poolPlan(samples, [{ name: 'L1', conc: 50 }, { name: 'L2', conc: 40 }, { name: 'L3', conc: 100 }], { targetNg: 1000, availUl: 20 });
  assert.equal(ok[0].limitedBy, null);
  assert.equal(Math.round(ok[0].each), 333);
  assert.equal(Math.round(ok[0].rows[0].ul * 100) / 100, 6.67);
  assert.equal(Math.round(ok[0].totalNg), 1000);
  // L2 at 10 ng/uL can give at most 200 ng from 20 uL
  const lim = poolPlan(samples, [{ name: 'L1', conc: 50 }, { name: 'L2', conc: 10 }, { name: 'L3', conc: 100 }], { targetNg: 1000, availUl: 20 });
  assert.equal(lim[0].limitedBy, 'L2');
  assert.equal(lim[0].each, 200);
  assert.equal(lim[0].totalNg, 600);
  assert.equal(lim[0].shortfall, 400);
  assert.equal(lim[0].rows[1].ul, 20);
});

test('poolPlan tolerates missing QC', () => {
  const p = poolPlan([{ name: 'a', pool: 1 }, { name: 'b', pool: 1 }], [{ name: 'a', conc: 25 }], { targetNg: 1000, availUl: 20 });
  assert.deepEqual(p[0].missing, ['b']);
  assert.equal(p[0].rows[0].ul, 20); // 500 ng wanted at 25 ng/uL = 20 uL
  assert.equal(p[0].rows[1].ul, null);
});

test('plateIssues: flagged well, other-batch well, duplicates, missing QC', () => {
  const plate = { samples: [{ name: 'a', well: 'D1', pool: 1 }, { name: 'a', well: 'D2', pool: 1 }, { name: 'c', well: 'D3', pool: null }] };
  const issues = plateIssues(plate, { D1: 'low volume' }, new Map([['D2', { batch: 'old', sample: 'z' }]]), [{ name: 'a', conc: 1 }]);
  const text = issues.map(i => i.text).join('\n');
  assert.match(text, /Duplicate sample names: a/);
  assert.match(text, /D1, flagged: low volume/);
  assert.match(text, /batch "old"/);
  assert.match(text, /No QC measurement for 1/);
  assert.match(text, /not in a pool/);
});

test('plate map CSV has one line per sample', () => {
  const samples = [{ name: 'L1', pool: 1, well: 'A1' }, { name: 'L,2', pool: 1, well: 'A2' }];
  const plan = poolPlan(samples, [{ name: 'L1', conc: 50 }], { targetNg: 100, availUl: 20 });
  const csv = plateMapCsv('plate 1', samples, plan).trim().split('\n');
  assert.equal(csv.length, 3);
  assert.equal(csv[1], 'L1,plate 1,A1,1,50,1');
  assert.ok(csv[2].startsWith('"L,2"'));
});
