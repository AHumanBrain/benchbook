import { parseQC, flagRow, summarize, DEFAULT_THRESHOLDS } from './qc.js';
import { fmt } from './calc.js';
import { esc, clock, db, persist, newId, hooks } from './shared.js';
import { toast } from './toast.js';

const LABELS = ['RNA input', 'Pre-capture libraries', 'Post-capture libraries', 'Pooled for hyb'];

function setCard(set, thr) {
  const sum = summarize(set.rows, thr);
  const max = sum.max || 1;
  const rows = set.rows.map(r => {
    const flags = flagRow(r, thr);
    const has = (...codes) => flags.some(f => codes.includes(f.code));
    const cls = bad => (bad ? 'num flag' : 'num');
    const bar = r.conc != null ? `<span class="barcell"><i style="width:${Math.max(2, (100 * r.conc) / max)}%"></i></span>` : '';
    return `<tr><td>${esc(r.name)}</td>
      <td class="${cls(has('conc-low', 'no-conc'))}">${r.conc != null ? fmt(r.conc, 1) : esc(r.rawConc || '–')}</td>
      <td class="barwrap">${bar}</td>
      <td class="${cls(has('r280-low', 'r280-high'))}">${r.r280 != null ? fmt(r.r280) : ''}</td>
      <td class="${cls(has('r230-low'))}">${r.r230 != null ? fmt(r.r230) : ''}</td>
      <td>${flags.map(f => `<span class="chip warn">${esc(f.text)}</span>`).join(' ')}</td></tr>`;
  }).join('');
  return `<div class="card"><div class="row spread"><div><h3>${esc(set.label)}</h3>
    <span class="muted small">${sum.n} samples · added ${clock(set.t)} · ${esc(set.format || 'table')}</span></div>
    <button class="btn small danger" data-act="qc-del" data-id="${esc(set.id)}">Delete</button></div>
    <div class="stats"><div class="stat"><b>${fmt(sum.median, 1)}</b><span>median ng/µL</span></div>
      <div class="stat"><b>${fmt(sum.min, 1)} – ${fmt(sum.max, 1)}</b><span>range ng/µL</span></div>
      <div class="stat"><b>${sum.flagged}</b><span>flagged of ${sum.n}</span></div></div>
    ${(set.warnings || []).map(w => `<p class="hint">⚠ ${esc(w)}</p>`).join('')}
    <div class="tablewrap"><table><thead><tr><th>Sample</th><th class="num">ng/µL</th><th></th><th class="num">260/280</th><th class="num">260/230</th><th>Flags</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

export function render(b, header) {
  const thr = db.settings.qc;
  const sets = b.qc.sets.map(s => setCard(s, thr)).join('');
  const field = (k, label, step) => `<label class="field">${label}<input type="number" step="${step}" min="0" data-chg="qc-thr" data-k="${k}" value="${thr[k]}"></label>`;
  return `${header(b, 'qc')}
  <div class="card"><h3>Add measurements</h3>
    <form data-act="qc-add">
      <div class="grid"><label class="field">What was measured
        <input type="text" name="label" list="qc-labels" value="Pre-capture libraries" required></label>
        <datalist id="qc-labels">${LABELS.map(l => `<option value="${l}">`).join('')}</datalist></div>
      <label class="field" style="margin-top:10px">Paste the table
        <textarea name="text" rows="6" placeholder="Paste a NanoDrop export copied from a spreadsheet (tab-separated, with a header row), a Qubit CSV, or two columns: sample name and concentration." required></textarea></label>
      <label class="field" style="margin-top:10px">Sample names (optional): one per line, in the same order as the rows
        <textarea name="names" rows="3" placeholder="Use this when the Sample ID column is blank. Leave empty to keep the names in the table."></textarea></label>
      <div class="row" style="margin-top:10px"><button class="btn primary">Add</button>
        <span class="muted small">Reads sample name, concentration, unit, 260/280 and 260/230 when they are there.</span></div>
    </form></div>
  ${sets || '<div class="empty">No measurements yet. Paste a table above.</div>'}
  <div class="card"><h3>Flag thresholds</h3>
    <div class="grid">${field('concMin', 'Min conc (ng/µL)', 0.5)}${field('r280Min', '260/280 min', 0.05)}${field('r280Max', '260/280 max', 0.05)}${field('r230Min', '260/230 min', 0.05)}</div>
    <p class="hint">These are generic starting points, not validated cut-offs. They apply to every batch. NanoDrop ratios are rough for low-concentration libraries.</p>
    <button class="btn small" data-act="qc-thr-reset">Reset to defaults</button></div>`;
}

export const clicks = {
  'qc-del': (el, b) => {
    const at = b.qc.sets.findIndex(s => s.id === el.dataset.id);
    const [gone] = b.qc.sets.splice(at, 1);
    const wasPooling = b.plate.qcSetId === gone.id;
    if (wasPooling) b.plate.qcSetId = null;
    toast(`Deleted "${gone.label}" (${gone.rows.length} readings).${wasPooling ? ' Its pool plan lost its concentrations.' : ''}`, {
      undo: () => { b.qc.sets.splice(at, 0, gone); if (wasPooling) b.plate.qcSetId = gone.id; persist(); hooks.render(); } });
  },
  'qc-thr-reset': () => { db.settings.qc = { ...DEFAULT_THRESHOLDS }; },
};

export const changes = {
  'qc-thr': el => {
    const v = Number(el.value);
    if (Number.isFinite(v) && v >= 0) db.settings.qc[el.dataset.k] = v;
  },
};

export const submits = {
  'qc-add': (form, data, b) => {
    const names = (data.names || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    const { rows, warnings, format } = parseQC(data.text, { names });
    if (!rows.length) { toast(`Nothing usable found: ${warnings.join('; ') || 'no rows'}.`, { kind: 'error' }); return 'none'; }
    b.qc.sets.push({ id: newId('q'), label: data.label.trim() || 'Measurements', t: new Date().toISOString(), format, warnings, rows });
  },
};
