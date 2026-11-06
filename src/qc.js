// QC import: parse pasted NanoDrop / Qubit / plain-table measurements and flag them. Pure, no DOM.

// Generic starting points, not validated cut-offs. Editable in the QC tab.
export const DEFAULT_THRESHOLDS = { concMin: 5, r280Min: 1.7, r280Max: 2.1, r230Min: 1.5 };

const MICRO = /[µμ]/g;
export const normUnit = u => String(u ?? '').toLowerCase().replace(MICRO, 'u').replace(/\s+/g, '');
const TO_NG_PER_UL = { 'ng/ul': 1, 'ug/ml': 1, 'ng/ml': 0.001, 'pg/ul': 0.001, 'ug/ul': 1000, 'pg/ml': 1e-6 };

function pickDelimiter(line) {
  if (line.includes('\t')) return '\t';
  const commas = (line.match(/,/g) || []).length;
  const semis = (line.match(/;/g) || []).length;
  if (semis > commas) return ';';
  return commas > 0 ? ',' : 'ws';
}

function splitLine(line, d) {
  if (d === 'ws') return line.trim().split(/\s+/);
  if (d === '\t') return line.split('\t').map(s => s.trim());
  const out = [];
  let cur = '', quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === d && !quoted) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const num = (s, decimalComma = false) => {
  if (s === undefined || s === null) return NaN;
  let t = String(s).replace(/\s/g, '');
  if (decimalComma) t = t.replace(',', '.');
  return /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t) ? Number(t) : NaN;
};

const findCol = (headers, tests) => {
  for (const t of tests) {
    const i = headers.findIndex(h => t.test(h));
    if (i >= 0) return i;
  }
  return -1;
};

/** Parse pasted text. Returns { rows, warnings, format }.
 *  rows: [{ name, conc (ng/µL or null), rawConc, unit, nM, r280, r230, date }] */
export function parseQC(text, { names = null } = {}) {
  const warnings = [];
  const lines = String(text ?? '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return { rows: [], warnings: ['nothing pasted'], format: null };
  const d = pickDelimiter(lines[0]);
  const decimalComma = d === ';';
  const table = lines.map(l => splitLine(l, d));
  const hasHeader = !table[0].some(c => Number.isFinite(num(c, decimalComma)));
  const headers = hasHeader ? table[0].map(h => h.toLowerCase().replace(MICRO, 'u').trim()) : [];
  const body = hasHeader ? table.slice(1) : table;

  let ni = 0, ci = 1, ui = -1, i280 = -1, i230 = -1, idate = -1, ihash = -1, format = 'simple';
  if (hasHeader) {
    ni = findCol(headers, [/^sample\s*(id|name)$/, /^(test\s*)?name$/, /^id$/, /sample/]);
    ci = findCol(headers, [/original sample conc\.?$/, /^nucleic acid$/, /^conc(entration)?\b/, /conc/]);
    ui = findCol(headers, [/^units?$/, /conc\.?\s*units?$/, /unit/]);
    i280 = findCol(headers, [/260\s*\/\s*280/]);
    i230 = findCol(headers, [/260\s*\/\s*230/]);
    idate = findCol(headers, [/date/]);
    ihash = findCol(headers, [/^#$/, /^no\.?$/, /^n°$/]);
    format = i280 >= 0 || i230 >= 0 ? 'nanodrop' : headers.some(h => /qubit|assay/.test(h)) ? 'qubit' : 'table';
    if (ni < 0) { warnings.push('no sample name column found; used the first column'); ni = 0; }
    if (ci < 0) { warnings.push('no concentration column found; used the second column'); ci = 1; }
  }

  let assumedUnit = false, blank = 0;
  const unknownUnits = new Set();
  const rows = [];
  for (const cells of body) {
    let name = (cells[ni] ?? '').trim();
    const rawConc = cells[ci] ?? '';
    const v = num(rawConc, decimalComma);
    if (!name) {
      if (!Number.isFinite(v)) continue; // no name and no number: junk
      name = `Sample ${(ihash >= 0 && cells[ihash]) || rows.length + 1}`;
      blank++;
    }
    const unitText = ui >= 0 ? (cells[ui] ?? '').trim() : '';
    const unit = normUnit(unitText);
    let conc = null, nM = null;
    if (Number.isFinite(v)) {
      if (!unit) { conc = v; assumedUnit = true; } else if (TO_NG_PER_UL[unit]) conc = v * TO_NG_PER_UL[unit];
      else if (unit === 'nm') nM = v;
      else unknownUnits.add(unitText);
    }
    const r280 = i280 >= 0 ? num(cells[i280], decimalComma) : NaN;
    const r230 = i230 >= 0 ? num(cells[i230], decimalComma) : NaN;
    rows.push({
      name, conc, rawConc, unit: unitText || 'ng/µL', nM,
      r280: Number.isFinite(r280) ? r280 : null,
      r230: Number.isFinite(r230) ? r230 : null,
      date: idate >= 0 ? cells[idate] ?? '' : '',
    });
  }
  if (names && names.length) {
    if (names.length !== rows.length) warnings.push(`${names.length} names for ${rows.length} rows: extra rows keep their default names`);
    rows.forEach((r, i) => { if (names[i]) r.name = names[i]; });
  } else if (blank) {
    warnings.push(`the Sample ID column was blank for ${blank} row(s): named "Sample 1", "Sample 2"… from the # column. Paste real names in the names box to replace them.`);
  }
  if (assumedUnit) warnings.push('no unit column: concentrations assumed to be ng/µL');
  if (unknownUnits.size) warnings.push(`unrecognised unit(s) ${[...unknownUnits].join(', ')}: those rows have no ng/µL value`);
  const dup = duplicateNames(rows);
  if (dup.length) warnings.push(`duplicate sample names: ${dup.join(', ')}`);
  return { rows, warnings, format };
}

export function duplicateNames(rows) {
  const seen = new Set(), dup = new Set();
  for (const r of rows) {
    const k = r.name.trim().toLowerCase();
    if (seen.has(k)) dup.add(r.name); else seen.add(k);
  }
  return [...dup];
}

/** Flags for one row: [{ code, text }]. Empty means nothing to report. */
export function flagRow(r, thr = DEFAULT_THRESHOLDS) {
  const f = [];
  if (r.conc === null || r.conc === undefined) f.push({ code: 'no-conc', text: r.nM != null ? 'molar unit, no ng/µL' : 'no concentration' });
  else if (r.conc < thr.concMin) f.push({ code: 'conc-low', text: `low conc (< ${thr.concMin} ng/µL)` });
  if (r.r280 != null) {
    if (r.r280 < thr.r280Min) f.push({ code: 'r280-low', text: `260/280 low (< ${thr.r280Min})` });
    else if (r.r280 > thr.r280Max) f.push({ code: 'r280-high', text: `260/280 high (> ${thr.r280Max})` });
  }
  if (r.r230 != null && r.r230 < thr.r230Min) f.push({ code: 'r230-low', text: `260/230 low (< ${thr.r230Min})` });
  return f;
}

export function summarize(rows, thr = DEFAULT_THRESHOLDS) {
  const concs = rows.map(r => r.conc).filter(c => c != null).sort((a, b) => a - b);
  const median = concs.length ? (concs.length % 2 ? concs[(concs.length - 1) / 2] : (concs[concs.length / 2 - 1] + concs[concs.length / 2]) / 2) : null;
  return {
    n: rows.length,
    withConc: concs.length,
    min: concs[0] ?? null,
    max: concs[concs.length - 1] ?? null,
    median,
    flagged: rows.filter(r => flagRow(r, thr).length).length,
  };
}
