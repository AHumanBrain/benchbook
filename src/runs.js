// Which batches belong to one run (a library prep and the hyb and capture that follows it). Pure, no DOM.
import { batchDate } from './dates.js';

/** 'prep' or 'hyb': stored on the batch, else guessed from its protocol (the xGen hyb and wash protocol and copies of it). */
export function roleOf(b) {
  if (b.role) return b.role;
  const text = `${b.protocol?.based_on || ''} ${b.protocol?.id || ''} ${b.protocol?.name || ''}`;
  return /xgen|hyb|capture/i.test(text) ? 'hyb' : 'prep';
}

export const linksOf = (batches, b) => (b.links || []).map(id => batches[id]).filter(Boolean);

/** Link two batches both ways. */
export function link(a, b) {
  for (const [x, y] of [[a, b], [b, a]]) x.links = [...new Set([...(x.links || []), y.id])];
}

export function unlink(a, b) {
  for (const [x, y] of [[a, b], [b, a]]) x.links = (x.links || []).filter(id => id !== y.id);
}

/** Dates for the strip: the first prep date, then the first hyb, capture and sequencing date anyone in the run has. */
export function runDates(list) {
  const first = (items, key) => items.map(b => b.info?.[key]).filter(Boolean).sort()[0] || '';
  const hyb = list.filter(b => roleOf(b) === 'hyb');
  const pick = key => first(hyb, key) || first(list, key);
  return { prep: first(list.filter(b => roleOf(b) === 'prep'), 'prep'), hyb: pick('hyb'), cap: pick('cap'), seq: pick('seq') };
}

const base = name => String(name).replace(/\s*·\s*(prep|hyb)\b.*$/i, '').trim() || String(name);

/** "Batch 5 + RNA iso" for a run made of two preps and one hyb. */
export function runName(list) {
  const names = [...new Set(list.map(b => base(b.name)))];
  return names.join(' + ');
}

/** All batches grouped into runs (connected through links, either direction), newest first. Unlinked batches are runs of one. */
export function runsOf(batches) {
  const all = Object.values(batches);
  const near = new Map(all.map(b => [b.id, new Set()]));
  for (const b of all) for (const other of linksOf(batches, b)) { near.get(b.id).add(other.id); near.get(other.id).add(b.id); }
  const seen = new Set();
  const runs = [];
  for (const b of all) {
    if (seen.has(b.id)) continue;
    const members = [];
    const stack = [b.id];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      members.push(batches[id]);
      for (const n of near.get(id)) if (!seen.has(n)) stack.push(n);
    }
    members.sort((x, y) => (roleOf(x) === roleOf(y) ? batchDate(x).localeCompare(batchDate(y)) : roleOf(x) === 'prep' ? -1 : 1));
    runs.push({ batches: members, dates: runDates(members), name: runName(members), date: members.map(batchDate).sort().pop() });
  }
  return runs.sort((x, y) => y.date.localeCompare(x.date));
}
