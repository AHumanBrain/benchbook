import { fmt } from './calc.js';
import { qcLabels, series, METRICS, libraryPoints, libraryQcSet, previousBatch, scaleMax, median } from './overview.js';
import { db, esc, poolColor } from './shared.js';

// One look for every chart: dots coloured by hyb pool (grey when a library has no pool), a ring for readings outside the QC
// thresholds, the median and the threshold labelled in the right margin.
const view = { label: null, metric: 'conc', setId: null, sameScale: true };   // what the pages are showing (not saved)
const dateText = iso => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
const fillOf = pool => (pool ? poolColor(pool) : 'var(--muted)');

function niceTicks(lo, hi, want = 5) {
  const raw = (hi - lo) / want;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  const ticks = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) ticks.push(Math.round(t * 1e6) / 1e6);
  return ticks;
}

/** [low, high] of the y axis. `sharedMax` makes the scale the same for every batch. */
const yRange = (metric, values, sharedMax) => {
  const top = Math.max(...values, sharedMax ?? 0);
  if (metric === 'r280') return [1, Math.max(2.4, top + 0.1)];
  if (metric === 'r230') return [0, Math.max(2.6, top + 0.1)];
  return [0, top * 1.08];
};

/** Gridlines, y labels and the QC threshold (labelled in the right margin so it never sits on a dot). */
function frame(metric, thr, [lo, hi], W, m, ph) {
  const pw = W - m.l - m.r;
  const y = v => m.t + ph - ((v - lo) / (hi - lo)) * ph;
  let svg = '';
  for (const t of niceTicks(lo, hi)) svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end" class="axis">${fmt(t, 2)}</text>`;
  const line = (v, text) => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" class="limit"/><text x="${W - m.r + 6}" y="${y(v) + 4}" class="limit-label">${text}</text>`;
  if (metric === 'conc') svg += line(thr.concMin, `min ${thr.concMin}`);
  if (metric === 'r230') svg += line(thr.r230Min, `min ${thr.r230Min}`);
  if (metric === 'r280') svg += `<rect x="${m.l}" width="${pw}" y="${y(thr.r280Max)}" height="${y(thr.r280Min) - y(thr.r280Max)}" class="band"/><text x="${W - m.r + 6}" y="${y(thr.r280Max) + 12}" class="limit-label">${thr.r280Min}–${thr.r280Max}</text>`;
  return { svg, y, pw };
}

/** What the colours mean, for exactly the dots in the chart above it. */
function key(points) {
  const pools = [...new Set(points.map(p => p.pool).filter(Boolean))].sort((a, b) => a - b);
  const parts = [];
  if (pools.length) parts.push('<span>Colour = hyb pool</span>', ...pools.map(p => `<span class="lg"><i style="background:${poolColor(p)}"></i>${p}</span>`));
  if (pools.length && points.some(p => !p.pool)) parts.push('<span class="lg"><i style="background:var(--muted)"></i>no pool</span>');
  if (points.some(p => p.flagged)) parts.push('<span class="lg"><i class="sw-ring"></i>ring = outside the QC thresholds</span>');
  return parts.length ? `<div class="row small muted chartkey">${parts.join('')}</div>` : '';
}

/* ---------- every batch: one strip of dots per batch ---------- */
function batchChart(rows, metric, thr) {
  const values = rows.flatMap(r => r.points.map(p => p.v));
  if (!values.length) return '<div class="empty">No measurements of this kind yet.</div>';
  const W = 900, H = 340, m = { l: 52, r: 78, t: 16, b: 86 };
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
      svg += `<circle cx="${cx(i) + dx}" cy="${f.y(p.v)}" r="4.6" class="dot ${p.flagged ? 'flag' : ''}" style="fill:${fillOf(p.pool)}"><title>${esc(r.name)} · ${esc(p.name)}: ${fmt(p.v, 2)}${p.pool ? ` · pool ${p.pool}` : ''}</title></circle>`;
    });
    if (r.median != null) svg += `<line x1="${cx(i) - band * 0.32}" x2="${cx(i) + band * 0.32}" y1="${f.y(r.median)}" y2="${f.y(r.median)}" class="median"/>`;
    const name = r.name.length > 16 ? `${r.name.slice(0, 15)}…` : r.name;
    svg += `<a href="#/b/${r.id}/graphs"><text x="${cx(i)}" y="${m.t + ph + 20}" text-anchor="middle" class="xl">${esc(name)}</text></a>
      <text x="${cx(i)}" y="${m.t + ph + 36}" text-anchor="middle" class="axis">${esc(dateText(r.date))}</text>
      <text x="${cx(i)}" y="${m.t + ph + 52}" text-anchor="middle" class="axis">median ${r.median != null ? fmt(r.median, metric === 'conc' ? 0 : 2) : '–'}</text>
      ${r.revision ? `<text x="${cx(i)}" y="${m.t + ph + 68}" text-anchor="middle" class="axis">rev ${r.revision}</text>` : ''}`;
  });
  return `<div class="chartwrap">${svg}</svg></div>${key(rows.flatMap(r => r.points))}`;
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
    <span class="muted small"><i class="sw-med"></i> median</span></div>
    ${batchChart(series(db.batches, label, metric, thr), metric, thr)}</div>`;
}

/* ---------- one batch: one dot per library, grouped by pool ---------- */
function libraryChart(points, metric, thr, sharedMax) {
  if (!points.length) return '<div class="empty">No measurements of this kind in this set.</div>';
  const groups = [];
  for (const p of points) {
    const g = groups[groups.length - 1];
    if (g && g.pool === p.pool) g.items.push(p); else groups.push({ pool: p.pool, items: [p] });
  }
  const W = 900, H = 390, m = { l: 52, r: 78, t: 22, b: 142 };   // room below for rotated library names, then the pool row
  const ph = H - m.t - m.b;
  const gap = 0.8;                                               // space between pools, in dot slots
  const slot = Math.min(56, (W - m.l - m.r) / (points.length + gap * (groups.length - 1)));
  const range = yRange(metric, points.map(p => p.v), sharedMax);
  const f = frame(metric, thr, range, W, m, ph);
  const base = f.y(range[0]);
  let x = m.l + slot / 2;
  for (const g of groups) {
    g.x0 = x;
    for (const p of g.items) { p.x = x; x += slot; }
    g.x1 = x - slot;
    x += slot * gap;
  }
  const med = median(points.map(p => p.v));
  const digits = metric === 'conc' ? 0 : 2;
  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(METRICS[metric].label)} of each library, grouped by hyb pool">${f.svg}
    <line class="median-line" x1="${m.l}" x2="${W - m.r}" y1="${f.y(med)}" y2="${f.y(med)}"/><text class="median-label" x="${W - m.r + 6}" y="${f.y(med) + 4}">median ${fmt(med, digits)}</text>`;
  for (const p of points) {
    const y = f.y(p.v);
    const name = p.name.length > 18 ? `${p.name.slice(0, 17)}…` : p.name;
    svg += `<line class="stem" x1="${p.x}" x2="${p.x}" y1="${y}" y2="${base}" style="stroke:${fillOf(p.pool)}"/>
      <circle class="dot big ${p.flagged ? 'flag' : ''}" cx="${p.x}" cy="${y}" r="6.5" style="fill:${fillOf(p.pool)}"><title>${esc(p.name)}: ${fmt(p.v, 2)}${p.pool ? ` · pool ${p.pool}` : ''}${p.flagged ? ' · outside the QC thresholds' : ''}</title></circle>
      ${points.length <= 30 ? `<text class="val" x="${p.x}" y="${y - 12}" text-anchor="middle">${fmt(p.v, digits)}</text>` : ''}
      <text class="name" transform="translate(${p.x + 4},${base + 16}) rotate(-35)" text-anchor="end">${esc(name)}</text>`;
  }
  const rowY = base + 108;
  for (const g of groups) {
    if (!g.pool) continue;
    svg += `<line class="bracket" x1="${g.x0 - slot * 0.35}" x2="${g.x1 + slot * 0.35}" y1="${rowY}" y2="${rowY}" style="stroke:${poolColor(g.pool)}"/>
      <text class="poolname" x="${(g.x0 + g.x1) / 2}" y="${rowY + 18}" text-anchor="middle">pool ${g.pool}</text>`;
  }
  return `<div class="chartwrap">${svg}</svg></div>${key(points)}`;
}

export function renderGraphs(b, header) {
  document.body.className = 'bench';
  const thr = db.settings.qc;
  const sets = b.qc.sets;
  if (!sets.length) return `${header(b, 'graphs')}<div class="empty">Paste QC measurements on the QC tab and each library is graphed here.</div>`;
  const metric = METRICS[view.metric] ? view.metric : 'conc';
  const setId = sets.find(s => s.id === view.setId)?.id || libraryQcSet(b).id;
  const { set, points } = libraryPoints(b, db.batches, setId, metric, thr);
  const shared = view.sameScale && metric === 'conc' ? scaleMax(db.batches, set.label, metric) : null;
  const prev = previousBatch(db.batches, b);
  return `${header(b, 'graphs')}
  <div class="card"><div class="row spread"><div class="row">
      <label class="field">Measurement<select data-chg="gr-set">${sets.map(s => `<option value="${s.id}" ${s.id === setId ? 'selected' : ''}>${esc(s.label)} (${s.rows.length})</option>`).join('')}</select></label>
      <label class="field">Metric<select data-chg="ov-metric">${Object.entries(METRICS).map(([k, mm]) => `<option value="${k}" ${k === metric ? 'selected' : ''}>${esc(mm.label)}</option>`).join('')}</select></label>
      ${metric === 'conc' ? `<label class="row small" style="align-self:end;padding-bottom:10px"><input type="checkbox" data-chg="gr-scale" ${view.sameScale ? 'checked' : ''}> Same scale as the other batches</label>` : ''}</div>
      ${prev ? `<a class="btn small" href="#/compare/${prev.id}/${b.id}">Compare with ${esc(prev.name)}</a>` : ''}</div>
    ${libraryChart(points, metric, thr, shared)}</div>`;
}

export const changes = {
  'ov-label': el => { view.label = el.value; },
  'ov-metric': el => { view.metric = el.value; },
  'gr-set': el => { view.setId = el.value; },
  'gr-scale': el => { view.sameScale = el.checked; },
};
