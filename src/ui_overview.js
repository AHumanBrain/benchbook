import { fmt } from './calc.js';
import { qcLabels, series, METRICS, libraryBars, libraryQcSet, previousBatch, batchDate } from './overview.js';
import { db, esc } from './shared.js';

const view = { label: null, metric: 'conc', setId: null }; // what the two pages are showing (not saved)
const dateText = iso => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
const poolColor = p => `hsl(${(p * 47 + 160) % 360} 55% 50%)`;

function niceTicks(lo, hi, want = 5) {
  const raw = (hi - lo) / want;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  const ticks = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) ticks.push(Math.round(t * 1e6) / 1e6);
  return ticks;
}

const yRange = (metric, values) => {
  const top = Math.max(...values);
  if (metric === 'r280') return [1, Math.max(2.4, top + 0.1)];
  if (metric === 'r230') return [0, Math.max(2.6, top + 0.1)];
  return [0, top * 1.08];
};

/** Gridlines, y labels and the threshold the QC flags use, shared by both graphs. */
function frame(metric, thr, [lo, hi], W, m, ph) {
  const pw = W - m.l - m.r;
  const y = v => m.t + ph - ((v - lo) / (hi - lo)) * ph;
  let svg = '';
  for (const t of niceTicks(lo, hi)) svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end" class="axis">${fmt(t, 2)}</text>`;
  const line = (v, text) => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" class="limit"/><text x="${W - m.r}" y="${y(v) - 5}" text-anchor="end" class="limit-label">${text}</text>`;
  if (metric === 'conc') svg += line(thr.concMin, `min ${thr.concMin}`);
  if (metric === 'r230') svg += line(thr.r230Min, `min ${thr.r230Min}`);
  if (metric === 'r280') svg += `<rect x="${m.l}" width="${pw}" y="${y(thr.r280Max)}" height="${y(thr.r280Min) - y(thr.r280Max)}" class="band"/><text x="${W - m.r}" y="${y(thr.r280Max) - 5}" text-anchor="end" class="limit-label">${thr.r280Min}–${thr.r280Max}</text>`;
  return { svg, y, pw };
}

/* ---------- per batch: every library, one column per batch ---------- */
function batchChart(rows, metric, thr) {
  const values = rows.flatMap(r => r.points.map(p => p.v));
  if (!values.length) return '<div class="empty">No measurements of this kind yet.</div>';
  const W = 880, H = 330, m = { l: 52, r: 16, t: 14, b: 86 };
  const ph = H - m.t - m.b;
  const f = frame(metric, thr, yRange(metric, values), W, m, ph);
  const band = f.pw / rows.length;
  const cx = i => m.l + band * (i + 0.5);
  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(METRICS[metric].label)} of each library, by batch">${f.svg}`;
  rows.forEach((r, i) => {
    if (r.newProtocol) svg += `<line x1="${m.l + band * i}" x2="${m.l + band * i}" y1="${m.t}" y2="${m.t + ph}" class="divider"/>`;
    const jitter = Math.min(band * 0.6, 70);
    r.points.forEach((p, k) => {
      const dx = (((k * 0.618034) % 1) - 0.5) * jitter;
      svg += `<circle cx="${cx(i) + dx}" cy="${f.y(p.v)}" r="4.2" class="dot ${p.flagged ? 'flag' : ''}"><title>${esc(r.name)} · ${esc(p.name)}: ${fmt(p.v, 2)}</title></circle>`;
    });
    if (r.median != null) svg += `<line x1="${cx(i) - band * 0.32}" x2="${cx(i) + band * 0.32}" y1="${f.y(r.median)}" y2="${f.y(r.median)}" class="median"/>`;
    const name = r.name.length > 16 ? `${r.name.slice(0, 15)}…` : r.name;
    svg += `<a href="#/b/${r.id}/graphs"><text x="${cx(i)}" y="${m.t + ph + 20}" text-anchor="middle" class="xl">${esc(name)}</text></a>
      <text x="${cx(i)}" y="${m.t + ph + 36}" text-anchor="middle" class="axis">${esc(dateText(r.date))}</text>
      <text x="${cx(i)}" y="${m.t + ph + 52}" text-anchor="middle" class="axis">median ${r.median != null ? fmt(r.median, metric === 'conc' ? 0 : 2) : '–'}</text>
      ${r.revision ? `<text x="${cx(i)}" y="${m.t + ph + 68}" text-anchor="middle" class="axis">rev ${r.revision}</text>` : ''}`;
  });
  return `<div class="chartwrap">${svg}</svg></div>`;
}

export function renderOverview() {
  document.body.className = 'bench';
  const thr = db.settings.qc;
  const labels = qcLabels(db.batches);
  if (!labels.length) return '<h1>Overview</h1><div class="empty">No QC measurements yet. Paste some on a batch\'s QC tab and they are graphed here, batch by batch.</div>';
  const label = labels.find(l => l.label === view.label)?.label || labels[0].label;
  const metric = METRICS[view.metric] ? view.metric : 'conc';
  return `<h1>Overview</h1>
  <p class="muted">Every library from every batch, so a drift between batches stands out. Dashed vertical lines mark where the protocol changed. Click a batch name to open its graph.</p>
  <div class="card"><div class="row spread"><div class="row">
      <label class="field">Measurement<select data-chg="ov-label">${labels.map(l => `<option value="${esc(l.label)}" ${l.label === label ? 'selected' : ''}>${esc(l.label)} (${l.batches} batch${l.batches === 1 ? '' : 'es'})</option>`).join('')}</select></label>
      <label class="field">Metric<select data-chg="ov-metric">${Object.entries(METRICS).map(([k, mm]) => `<option value="${k}" ${k === metric ? 'selected' : ''}>${esc(mm.label)}</option>`).join('')}</select></label></div>
    <span class="muted small"><i class="sw-dot"></i> library <i class="sw-dot flag"></i> flagged <i class="sw-med"></i> median</span></div>
    ${batchChart(series(db.batches, label, metric, thr), metric, thr)}</div>`;
}

/* ---------- per library: one bar each, within one batch ---------- */
function libraryChart(bars, metric, thr) {
  if (!bars.length) return '<div class="empty">No measurements of this kind in this set.</div>';
  const W = 880, H = 320, many = bars.length > 14, m = { l: 52, r: 16, t: 18, b: many ? 78 : 44 };
  const ph = H - m.t - m.b;
  const f = frame(metric, thr, yRange(metric, bars.map(b => b.v)), W, m, ph);
  const band = f.pw / bars.length;
  const bw = Math.min(band * 0.72, 46);
  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(METRICS[metric].label)} of each library">${f.svg}`;
  bars.forEach((b, i) => {
    const x = m.l + band * (i + 0.5);
    const top = f.y(b.v), base = f.y(yRange(metric, bars.map(q => q.v))[0]);
    svg += `<rect x="${x - bw / 2}" y="${top}" width="${bw}" height="${Math.max(1, base - top)}" rx="3" class="col ${b.flagged ? 'flag' : ''}" ${!b.flagged && b.pool ? `style="fill:${poolColor(b.pool)}"` : ''}><title>${esc(b.name)}: ${fmt(b.v, 2)}${b.pool ? ` · pool ${b.pool}` : ''}${b.flagged ? ' · flagged' : ''}</title></rect>`;
    if (bars.length <= 24) svg += `<text x="${x}" y="${top - 5}" text-anchor="middle" class="axis">${fmt(b.v, metric === 'conc' ? 0 : 2)}</text>`;
    const label = b.name.length > 10 ? `${b.name.slice(0, 9)}…` : b.name;
    svg += many
      ? `<text transform="translate(${x + 4},${m.t + ph + 14}) rotate(-45)" text-anchor="end" class="axis">${esc(label)}</text>`
      : `<text x="${x}" y="${m.t + ph + 18}" text-anchor="middle" class="axis">${esc(label)}</text>`;
  });
  return `<div class="chartwrap">${svg}</svg></div>`;
}

export function renderGraphs(b, header) {
  document.body.className = 'bench';
  const thr = db.settings.qc;
  const sets = b.qc.sets;
  if (!sets.length) return `${header(b, 'graphs')}<div class="empty">Paste QC measurements on the QC tab and each library is graphed here.</div>`;
  const metric = METRICS[view.metric] ? view.metric : 'conc';
  const setId = sets.find(s => s.id === view.setId)?.id || libraryQcSet(b).id;
  const { bars } = libraryBars(b, setId, metric, thr);
  const pools = [...new Set(bars.map(x => x.pool).filter(Boolean))].sort((a, c) => a - c);
  const prev = previousBatch(db.batches, b);
  return `${header(b, 'graphs')}
  <div class="card"><div class="row spread"><div class="row">
      <label class="field">Measurement<select data-chg="gr-set">${sets.map(s => `<option value="${s.id}" ${s.id === setId ? 'selected' : ''}>${esc(s.label)} (${s.rows.length})</option>`).join('')}</select></label>
      <label class="field">Metric<select data-chg="ov-metric">${Object.entries(METRICS).map(([k, mm]) => `<option value="${k}" ${k === metric ? 'selected' : ''}>${esc(mm.label)}</option>`).join('')}</select></label></div>
      ${prev ? `<a class="btn small" href="#/compare/${prev.id}/${b.id}">Compare with ${esc(prev.name)}</a>` : ''}</div>
    ${libraryChart(bars, metric, thr)}
    <div class="row small muted">${pools.length ? `Bar colour = hyb pool: ${pools.map(p => `<span class="lg"><i style="background:${poolColor(p)}"></i>${p}</span>`).join('')}` : ''}<span class="lg"><i class="sw-flag"></i>flagged</span></div></div>`;
}

export const changes = {
  'ov-label': el => { view.label = el.value; },
  'ov-metric': el => { view.metric = el.value; },
  'gr-set': el => { view.setId = el.value; },
};
