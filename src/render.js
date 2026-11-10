// Step renderers and bench timers, shared by the batch pages and the protocol editor preview.
import { fmt, fmtDuration, mixTable, programSeconds, NOTE_TAGS } from './calc.js';
import { esc, clock } from './shared.js';

/* ---------- timers ---------- */
const beeped = new Set();
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.25, 0.5].forEach(t => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.value = 880; g.gain.value = 0.15; o.connect(g); g.connect(ctx.destination);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.15);
    });
  } catch { /* no audio available */ }
}
export function timerText(endIso, key) {
  const left = Math.round((new Date(endIso) - Date.now()) / 1000);
  if (left <= 0) {
    if (!beeped.has(key + endIso)) { beeped.add(key + endIso); beep(); }
    return { text: 'done', cls: 'finished' };
  }
  const h = Math.floor(left / 3600), m = Math.floor((left % 3600) / 60), s = left % 60;
  return { text: `${h ? h + ':' + String(m).padStart(2, '0') : m}:${String(s).padStart(2, '0')}`, cls: 'running' };
}
setInterval(() => {
  document.querySelectorAll('.timer[data-end]').forEach(el => {
    const { text, cls } = timerText(el.dataset.end, el.dataset.key);
    el.className = `timer ${cls}`;
    el.querySelector('.clock').textContent = text;
  });
}, 1000);

/* ---------- rendering pieces ---------- */
export function renderMix(step, b) {
  const t = mixTable(step, b.n, b.overagePct);
  const rows = t.mmRows.map(r => `<tr><td>${esc(r.name)}</td><td class="num">${fmt(r.perRxn)}</td><td class="num"><b>${fmt(r.total, 1)}</b></td></tr>`).join('');
  const adds = t.addRows.map(r => `<tr><td>${esc(r.name)} <span class="muted small">(add per reaction)</span></td><td class="num">${fmt(r.perRxn)}</td><td class="num">${fmt(r.total, 1)}</td></tr>`).join('');
  const input = step.input
    ? `<tr><td>${esc(step.input.name)} <span class="muted small">${step.input.note ? esc(step.input.note) : '(sample)'}</span></td><td class="num">${step.input.vol != null ? fmt(step.input.vol) : '–'}</td><td class="num">${step.input.vol != null ? fmt(step.input.vol * b.n) : ''}</td></tr>`
    : '';
  const dispense = t.dispense != null
    ? `<tr class="total"><td>Master mix, dispense per reaction</td><td class="num">${fmt(t.dispense)}</td><td class="num">${fmt(t.mmTotal, 1)} mixed</td></tr>`
    : t.mmRows.length ? `<tr class="total"><td>Total volume to prepare</td><td class="num">${fmt(t.mmPerRxn)}</td><td class="num">${fmt(t.mmTotal, 1)}</td></tr>` : '';
  const final = t.finalVol ? `<p class="hint">Final reaction volume: ${fmt(t.finalVol)} µL</p>` : '';
  return `<h3>${esc(step.title)}</h3>
  <div class="tablewrap"><table><thead><tr><th>Component</th><th class="num">µL / rxn</th><th class="num">µL for ${Number(b.n)} (+${Number(b.overagePct)}%)</th></tr></thead>
  <tbody>${input}${rows}${dispense}${adds}</tbody></table></div>${final}`;
}

function renderProgramRows(program, indent = false) {
  return program.map(item => {
    if (item.cycles) {
      return `<tr class="cycle"><td colspan="3"><b>${item.cycles}×</b> cycle</td></tr>${renderProgramRows(item.steps, true)}`;
    }
    return `<tr><td class="${indent ? 'indent' : ''}">${esc(item.name)}</td><td class="num">${item.temp_c} °C</td><td class="num">${fmtDuration(item.duration_s)}</td></tr>`;
  }).join('');
}

export function renderThermo(step) {
  const total = programSeconds(step.program);
  return `<h3>${esc(step.title)}</h3>
  <div class="tablewrap"><table><thead><tr><th>Step</th><th class="num">Temp</th><th class="num">Time</th></tr></thead><tbody>${renderProgramRows(step.program)}</tbody></table></div>
  <div class="chips">${total ? `<span class="chip">runs ≈ ${fmtDuration(total)}</span>` : ''}${step.lid_c ? `<span class="chip">lid ${step.lid_c} °C</span>` : ''}</div>`;
}

export function renderPlain(step, n) {
  const vol = step.per_rxn_vol != null
    ? `<div class="chips"><span class="chip">${fmt(step.per_rxn_vol)} µL / rxn</span><span class="chip">${fmt(step.per_rxn_vol * n, 1)} µL for ${n}${step.per_label ? ' ' + esc(step.per_label) : ''}</span></div>`
    : '';
  return `<div class="text">${esc(step.text)}</div>${vol}`;
}

export function timerSeconds(step) {
  if (step.timer_min) return step.timer_min * 60;
  if (step.type === 'thermocycle') return programSeconds(step.program) || null;
  return null;
}

function renderTimer(it, st) {
  const secs = timerSeconds(it.step);
  if (!secs) return '';
  if (st.timer) {
    const { text, cls } = timerText(st.timer, it.key);
    return `<span class="timer ${cls}" data-key="${it.key}" data-end="${st.timer}"><span class="clock">${text}</span>
      <button class="btn small" data-act="timer-stop" data-key="${it.key}">Stop</button></span>`;
  }
  return `<span class="timer"><button class="btn small" data-act="timer-start" data-key="${it.key}">⏱ Start ${fmtDuration(secs)}</button></span>`;
}

function renderNotes(b, it, st) {
  const list = (st.notes || []).map((n, i) => `<div class="note ${esc(n.tag)}"><span class="tag">${esc(n.tag)}</span>${esc(n.text)}<span class="when">${clock(n.t)}</span>
    <button class="btn small bench-only" data-act="note-del" data-key="${it.key}" data-i="${i}" aria-label="Delete note">×</button></div>`).join('');
  return `<div class="notes">${list}</div>
  <details class="addnote bench-only"><summary>＋ add note</summary>
    <form data-act="note-add" data-key="${it.key}">
      <input type="text" name="text" placeholder="What happened?" required autocomplete="off">
      <select name="tag" aria-label="Note type">${NOTE_TAGS.map(t => `<option>${t}</option>`).join('')}</select>
      <button class="btn small primary">Save</button>
    </form></details>`;
}

export function renderItem(b, it) {
  const st = b.state[it.key] || {};
  const s = it.step;
  const body = s.type === 'mix' ? renderMix(s, b) : s.type === 'thermocycle' ? renderThermo(s) : renderPlain(s, b.n);
  const note = s.note ? `<p class="hint">${esc(s.note)}</p>` : '';
  return `<li class="item ${st.done ? 'done' : ''}" id="item-${it.key}">
    <input class="check" type="checkbox" data-act="toggle" data-key="${it.key}" ${st.done ? 'checked' : ''} aria-label="Mark step done">
    <div class="body">
      ${it.heading ? `<div class="heading">${esc(it.heading)}</div>` : ''}
      ${body}${note}
      <div class="row bench-only">${renderTimer(it, st)}${st.done ? `<span class="muted small">done ${clock(st.done)}</span>` : ''}</div>
      ${renderNotes(b, it, st)}
    </div></li>`;
}
