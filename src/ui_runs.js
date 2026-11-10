import { flattenProtocol, progress, fmt } from './calc.js';
import { poolPlan } from './plate.js';
import { runsOf, roleOf, linksOf, link, unlink } from './runs.js';
import { planNextBatch, planHybFromPrep, bumpName, hybName, todayLocal, wellRanges } from './nextbatch.js';
import { batchDate } from './overview.js';
import { db, persist, esc, clock, newId, ensureBatch, hooks, own } from './shared.js';
import { toast } from './toast.js';

const ROLE = { prep: 'library prep', hyb: 'hyb & capture' };
const rev = p => (p.revision ? ` rev ${esc(p.revision)}` : '');
const cap = t => String(t).charAt(0).toUpperCase() + String(t).slice(1);

/* ---------- the batch list: one quiet card per run ---------- */
const span = (dates, fallback) => {
  const days = [dates.prep, dates.hyb, dates.cap, dates.seq].filter(Boolean).sort();
  if (!days.length) return clock(fallback);
  return days[0] === days.at(-1) ? clock(days[0]) : `${clock(days[0])} – ${clock(days.at(-1))}`;
};

const batchLink = b => {
  const p = progress(b, flattenProtocol(b.protocol));
  const state = p.total && p.done === p.total ? '✓' : `${p.done}/${p.total}`;
  return `<a class="runlink" href="#/b/${esc(b.id)}/bench">${esc(b.name)} <span class="muted small">${state}</span></a>`;
};

export function renderBatchList() {
  const runs = runsOf(db.batches);
  if (!runs.length) return '<div class="empty">No batches yet. Start one below.</div>';
  return runs.map(run => `<div class="card run"><div class="row spread"><h3>${esc(run.name)}</h3><span class="muted small">${esc(span(run.dates, run.batches[0].created))}</span></div>
    <div class="runlinks">${run.batches.map(batchLink).join('')}</div></div>`).join('');
}

/* ---------- start the next batch from this one ---------- */
function protocolCandidates(from) {
  const own = from.protocol;
  const out = [{ label: `Same as ${from.name}${own.revision ? ` (rev ${own.revision})` : ''}`, protocol: own }];
  for (const p of Object.values(db.protocols)) {
    if (p.id === own.id || p.based_on === own.id) out.push({ label: `Your protocol "${p.name}" (rev ${p.revision || 1})`, protocol: p });
  }
  return out;
}

function previewHtml(from, v) {
  const cands = protocolCandidates(from);
  const cand = cands[v.proto] || cands[0];
  const plan = planNextBatch({ from, batches: db.batches, plates: db.plates, name: v.name, n: v.n, overagePct: v.overage, protocol: cand.protocol, today: todayLocal(), id: 'preview' });
  const rows = [
    `Protocol: <b>${esc(cand.protocol.name)}${esc(rev(cand.protocol))}</b>`,
    `Master-mix overage <b>${v.overage}%</b>${plan.batch.info.thermocycler ? `, thermocycler <b>${esc(plan.batch.info.thermocycler)}</b>` : ''}`,
    `${roleOf(from) === 'prep' ? 'Library prep' : 'Hyb'} date set to today. Nothing is ticked and there are no readings yet.`,
  ];
  if (roleOf(from) === 'prep') {
    const plex = plan.batch.plate.plex;
    rows.push(`${v.n} libraries named <b>Sample 1</b> to <b>Sample ${v.n}</b>, grouped in pools of ${plex}.`);
    if (plan.plateName) {
      rows.push(plan.wells.length ? `On <b>${esc(plan.plateName)}</b>, wells <b>${esc(wellRanges(plan.wells, plan.batch.plate.order))}</b> (skipping wells other batches used and flagged wells).` : `Index plate: <b>${esc(plan.plateName)}</b>, but no free wells.`);
      if (plan.unassigned) rows.push(`<span class="warnline">${plan.unassigned} librar${plan.unassigned === 1 ? 'y does' : 'ies do'} not fit on the plate. They get wells once you free some or choose another plate.</span>`);
    } else rows.push('No index plate yet: choose one on the Plate & pools tab.');
  }
  return `<ul class="preview">${rows.map(r => `<li>${r}</li>`).join('')}</ul>`;
}

export function renderNext(id) {
  document.body.className = 'bench';
  const from = own(db.batches, id);
  if (!from) return '<h1>Next batch</h1><div class="empty">That batch no longer exists.</div>';
  const cands = protocolCandidates(from);
  const v = { name: bumpName(from.name, Object.values(db.batches).map(b => b.name)), n: from.n, overage: from.overagePct, proto: 0 };
  return `<a href="#/b/${esc(from.id)}/info">← ${esc(from.name)}</a>
  <h1>Start the next batch</h1>
  <p class="muted">Like <b>${esc(from.name)}</b>: same protocol, overage and thermocycler${roleOf(from) === 'prep' ? ', and the new libraries go on the next free index wells' : ''}. Everything else starts fresh.</p>
  <form class="card" data-act="rn-next" data-from="${esc(from.id)}">
    <div class="grid">
      <label class="field">Batch name<input type="text" name="name" data-chg="rn-field" value="${esc(v.name)}" required></label>
      <label class="field">${esc(cap(from.protocol.unit_label))}<input type="number" name="n" data-chg="rn-field" min="1" max="384" value="${esc(v.n)}" required></label>
      <label class="field">Master-mix overage %<input type="number" name="overage" data-chg="rn-field" min="0" max="50" value="${v.overage}" required></label>
      ${cands.length > 1 ? `<label class="field">Protocol<select name="protocol" data-chg="rn-field">${cands.map((c, i) => `<option value="${i}">${esc(c.label)}</option>`).join('')}</select></label>` : ''}
    </div>
    <h3 style="margin-top:14px">What you get</h3>
    <div id="nx-preview">${previewHtml(from, v)}</div>
    <div class="row" style="margin-top:12px"><button class="btn primary">Create batch</button><a class="btn" href="#/">Cancel</a></div>
  </form>`;
}

function readForm(form) {
  const f = new FormData(form);
  return { name: String(f.get('name') || '').trim(), n: Math.min(384, Math.max(1, Number(f.get('n')) || 1)), overage: Math.min(50, Math.max(0, Number(f.get('overage')) || 0)), proto: Number(f.get('protocol') || 0) };
}

/* ---------- on a batch: links, hyb from prep ---------- */
export function headerLinks(b) {
  const links = linksOf(db.batches, b);
  if (!links.length) return '';
  return `<div class="muted small">Linked: ${links.map(l => `<a href="#/b/${esc(l.id)}/bench">${esc(l.name)}</a> <span class="chip">${ROLE[roleOf(l)]}</span>`).join(' ')}</div>`;
}

export function infoCards(b) {
  const links = linksOf(db.batches, b);
  const role = roleOf(b);
  const others = Object.values(db.batches).filter(x => x.id !== b.id && roleOf(x) !== role && !(b.links || []).includes(x.id)).sort((x, y) => batchDate(y).localeCompare(batchDate(x)));
  const pools = new Set((b.plate?.samples || []).map(s => s.pool).filter(Boolean)).size;
  const canMakeHyb = role === 'prep' && !links.some(l => roleOf(l) === 'hyb');
  return `<div class="card"><h3>Linked batches</h3>
    ${links.length ? links.map(l => `<div class="row spread" style="margin:6px 0"><span><span class="chip">${ROLE[roleOf(l)]}</span> <a href="#/b/${esc(l.id)}/bench">${esc(l.name)}</a></span>
      <button class="btn small" data-act="rn-unlink" data-id="${esc(l.id)}">Unlink</button></div>`).join('') : '<p class="muted small">None yet. A library prep and the hyb and capture that follows it belong together.</p>'}
    ${others.length ? `<div class="row" style="margin-top:8px"><select id="rn-pick" aria-label="Batch to link">${others.map(x => `<option value="${esc(x.id)}">${esc(x.name)} (${ROLE[roleOf(x)]})</option>`).join('')}</select><button class="btn small" data-act="rn-link">Link</button></div>` : ''}
    ${canMakeHyb ? `<div style="margin-top:12px"><button class="btn primary" data-act="rn-hyb">Create the hyb &amp; capture batch from this prep</button>
      <p class="hint">${pools ? `One hyb per pool (${pools}), with the pooling volumes on its Bench tab.` : 'Group the libraries into pools on the Plate &amp; pools tab first.'}</p></div>` : ''}</div>
  <div class="card row spread"><div><h3>Next batch</h3><span class="muted small">Copies the protocol, overage and thermocycler${role === 'prep' ? ' and puts the new libraries on the next free index wells' : ''}.</span></div>
    <a class="btn primary" href="#/next/${esc(b.id)}">Start the next batch from this one</a></div>`;
}

/** On a hyb batch: what to pool, from the linked prep's pooling plan. */
export function poolingCard(b) {
  if (roleOf(b) !== 'hyb') return '';
  const preps = linksOf(db.batches, b).filter(x => roleOf(x) === 'prep');
  if (!preps.length) return '';
  const body = preps.map(prep => {
    const set = prep.qc.sets.find(s => s.id === prep.plate.qcSetId);
    const plan = poolPlan(prep.plate.samples, set?.rows, { targetNg: prep.plate.targetNg, availUl: prep.plate.availUl });
    if (!plan.length) return `<p class="hint"><b>${esc(prep.name)}</b>: no pools yet. <a href="#/b/${esc(prep.id)}/plate">Group the libraries into pools</a> to see the volumes here.</p>`;
    const rows = plan.map(p => `<tr><td><b>${esc(p.pool)}</b></td><td>${p.rows.map(r => `<span class="chip">${esc(r.name)} · ${r.ul != null ? `${fmt(r.ul, 2)} µL` : '?'}</span>`).join(' ')}</td>
      <td class="num">${fmt(p.totalUl, 1)} µL</td><td class="num ${p.limitedBy ? 'flag' : ''}">${fmt(p.totalNg, 0)} ng</td></tr>`).join('');
    return `<p class="hint" style="margin-top:0"><b>${esc(prep.name)}</b>: ${prep.plate.targetNg} ng per hyb, equal mass${set ? `, from "${esc(set.label)}"` : ''}.
      <a href="#/b/${esc(prep.id)}/plate">Plate &amp; pools</a></p>
      <div class="tablewrap"><table><thead><tr><th>Pool</th><th>Libraries and volume to take</th><th class="num">Total</th><th class="num">Mass</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }).join('');
  return `<details class="card poolcard" open><summary><b>Pooling plan</b> <span class="muted small">from the linked prep</span></summary>${body}</details>`;
}

/* ---------- actions ---------- */
export const clicks = {
  'rn-link': (el, b) => {
    const other = own(db.batches, document.getElementById('rn-pick')?.value);
    if (!b || !other) return 'none';
    link(b, other);
    toast(`Linked to "${other.name}".`);
  },
  'rn-unlink': (el, b) => {
    const other = own(db.batches, el.dataset.id);
    if (!b || !other) return 'none';
    unlink(b, other);
    toast(`Unlinked "${other.name}".`, { undo: () => { link(b, other); persist(); hooks.render(); } });
  },
  'rn-hyb': async (el, b) => {
    const hybs = Object.values(db.batches).filter(x => roleOf(x) === 'hyb').sort((x, y) => batchDate(y).localeCompare(batchDate(x)));
    const previousHyb = hybs[0] || null;
    const protocol = previousHyb ? structuredClone(previousHyb.protocol) : await hooks.loadProtocol('xgen_hyb_wash_v3');
    const taken = new Set(Object.values(db.batches).map(x => x.name.toLowerCase()));
    const base = hybName(b.name);
    let finalName = base, i = 2;
    while (taken.has(finalName.toLowerCase())) finalName = `${base} (${i++})`;
    const r = planHybFromPrep({ prep: b, protocol, previousHyb, name: finalName, id: newId('b') });
    if (r.error) { toast(r.error, { kind: 'warn' }); return 'none'; }
    const hyb = ensureBatch(r.batch);
    db.batches[hyb.id] = hyb;
    link(b, hyb);
    persist();
    location.hash = `#/b/${hyb.id}/bench`;
    toast(`Created "${hyb.name}": ${hyb.n} hybs, one per pool. The pooling plan is at the top of its Bench tab.`);
    return 'none';
  },
};

export const changes = {
  'rn-field': el => {
    const form = el.closest('form');
    const from = own(db.batches, form.dataset.from);
    const box = document.getElementById('nx-preview');
    if (from && box) box.innerHTML = previewHtml(from, readForm(form));
    return 'none';
  },
};

export const submits = {
  'rn-next': (form) => {
    const from = own(db.batches, form.dataset.from);
    if (!from) return 'none';
    const v = readForm(form);
    const cands = protocolCandidates(from);
    const plan = planNextBatch({ from, batches: db.batches, plates: db.plates, name: v.name || bumpName(from.name, []), n: v.n, overagePct: v.overage, protocol: structuredClone((cands[v.proto] || cands[0]).protocol), today: todayLocal(), id: newId('b') });
    const b = ensureBatch(plan.batch);
    db.batches[b.id] = b;
    persist();
    location.hash = `#/b/${b.id}/bench`;
    toast(plan.wells.length ? `Started "${b.name}". Libraries are on wells ${wellRanges(plan.wells, b.plate.order)}.${plan.unassigned ? ` ${plan.unassigned} did not fit.` : ''}` : `Started "${b.name}".`, { kind: plan.unassigned ? 'warn' : 'info' });
    return 'none';
  },
};
