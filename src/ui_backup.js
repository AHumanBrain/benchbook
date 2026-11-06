import { db, persist, esc, download, ensureBatch } from './shared.js';
import { buildBackup, parseBackup, mergePlan, mergeBackup, summary, backupStatus, daysSince } from './backup.js';
import * as folder from './folder.js';

export function status() {
  const hasData = Object.keys(db.batches).length + Object.keys(db.protocols).length > 0;
  return backupStatus({ folder: folder.state, lastExport: db.settings.lastExport, hasData });
}

export function chip() {
  const s = status();
  if (s.level === 'none') return '';
  return `<a class="chip-backup ${s.level}" href="#/backup" title="${esc(s.detail)}">${s.level === 'ok' ? '✓' : '●'} ${esc(s.text)}</a>`;
}

const names = (backup, ids, key) => ids.map(id => esc(backup[key][id]?.name || id)).join(', ');

function folderCard() {
  const st = folder.state;
  if (!folder.supported) {
    return `<div class="card"><h3>Auto-save to a folder</h3><p class="muted">This browser cannot save to a folder. Chrome and Edge on a computer can. Use the file export below instead.</p></div>`;
  }
  let body;
  if (st.status === 'ok') {
    body = `<p>✓ Saving every change to <b>${esc(st.name)}/benchbook-backup.json</b>${st.lastSaved ? `, last at ${new Date(st.lastSaved).toLocaleTimeString()}` : ''}.</p>
      <div class="row"><button class="btn" data-act="bk-save-now">Save now</button><button class="btn danger" data-act="bk-off">Stop auto-save</button></div>
      <p class="hint">Put this folder inside Dropbox, OneDrive or iCloud Drive and the file is backed up off this machine too.</p>`;
  } else if (st.status === 'needs-permission') {
    body = `<p>Auto-save to <b>${esc(st.name)}</b> is paused. After a browser restart it needs one click to continue.</p>
      <div class="row"><button class="btn primary" data-act="bk-reconnect">Reconnect</button><button class="btn danger" data-act="bk-off">Stop auto-save</button></div>`;
  } else if (st.status === 'conflict') {
    const backup = st.fileBackup;
    const batchIds = st.missing.filter(id => backup.batches[id]);
    const protoIds = st.missing.filter(id => backup.protocols[id]);
    body = `<div class="note deviation">The file in <b>${esc(st.name)}</b> holds data this browser does not have:
      ${batchIds.length ? `<br><b>${batchIds.length} batch(es):</b> ${names(backup, batchIds, 'batches')}` : ''}
      ${protoIds.length ? `<br><b>${protoIds.length} protocol(s):</b> ${names(backup, protoIds, 'protocols')}` : ''}
      <br>Auto-save is paused so nothing is overwritten. This happens on a new browser or after browser data was cleared.</div>
      <div class="row" style="margin-top:10px"><button class="btn primary" data-act="bk-merge">Add them to this browser and continue</button>
        <button class="btn danger" data-act="bk-overwrite">Overwrite the folder file with this browser's data</button>
        <button class="btn" data-act="bk-off">Stop auto-save</button></div>`;
  } else if (st.status === 'error') {
    body = `<div class="note error">Auto-save stopped: ${esc(st.message)}</div>
      <div class="row" style="margin-top:10px"><button class="btn" data-act="bk-reconnect">Try again</button>
        <button class="btn danger" data-act="bk-overwrite">Replace the folder file with this browser's data</button>
        <button class="btn" data-act="bk-off">Stop auto-save</button></div>`;
  } else {
    body = `<p>Pick a folder and benchbook writes a backup file there after every change. If this browser's data is ever lost, restore from that file.</p>
      <button class="btn primary" data-act="bk-connect">Choose backup folder</button>`;
  }
  return `<div class="card"><h3>Auto-save to a folder</h3>${body}${st.message && st.status !== 'error' ? `<p class="hint">${esc(st.message)}</p>` : ''}</div>`;
}

export function render() {
  document.body.className = 'bench';
  const sum = summary({ batches: db.batches, plates: db.plates, protocols: db.protocols });
  const d = daysSince(db.settings.lastExport);
  return `<h1>Backup</h1>
  <p class="muted">Your batches live only in this browser. These two options keep a copy somewhere else.</p>
  ${folderCard()}
  <div class="card"><h3>Export everything to a file</h3>
    <p class="muted small">${sum.batches} batches · ${sum.protocols} custom protocols · ${sum.plates} index plates. ${d === null ? 'Never exported.' : d === 0 ? 'Last exported today.' : `Last exported ${d} day(s) ago.`}</p>
    <div class="row"><button class="btn primary" data-act="bk-export">Export everything</button>
      <label class="btn">Restore from a backup file<input type="file" accept="application/json,.json" data-chg="bk-restore" hidden></label></div>
    <p class="hint">Restoring adds batches and protocols that are missing. It never deletes anything, and asks before replacing a batch that exists in both.</p></div>`;
}

export const clicks = {
  'bk-export': () => {
    download(`benchbook-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(buildBackup(db), null, 1));
    db.settings.lastExport = new Date().toISOString();
    persist();
  },
  'bk-connect': async () => { try { await folder.connect(); } catch (e) { alert(`Could not use that folder: ${e.message}`); } },
  'bk-reconnect': () => folder.reconnect(),
  'bk-save-now': () => folder.saveNow(),
  'bk-off': () => folder.disconnect(),
  'bk-overwrite': () => {
    if (confirm('Replace the file in the folder with the data in this browser? Anything only in that file will be lost.')) return folder.overwriteFolder();
    return 'none';
  },
  'bk-merge': async () => {
    const res = await folder.mergeFromFolder();
    alert(`Added ${res.added} item(s) from the folder. Auto-save has resumed.`);
  },
};

export const changes = {
  'bk-restore': async el => {
    const file = el.files[0];
    if (!file) return 'none';
    try {
      const backup = parseBackup(await file.text());
      const plan = mergePlan(db, backup);
      const s = summary(backup);
      const adding = plan.newBatches.length + plan.newProtocols.length;
      let overwrite = false;
      if (plan.clashBatches.length || plan.clashProtocols.length) {
        overwrite = confirm(`${plan.clashBatches.length} batch(es) and ${plan.clashProtocols.length} protocol(s) in the file also exist here.\n\nOK = replace them with the file's versions.\nCancel = keep the versions in this browser.`);
      }
      if (!adding && !overwrite) { alert(`The file holds ${s.batches} batches and ${s.protocols} protocols; this browser already has all of them. Nothing changed.`); return 'none'; }
      const res = mergeBackup(db, backup, { overwrite });
      Object.values(db.batches).forEach(ensureBatch);
      persist();
      alert(`Restored: ${res.added} added, ${res.overwritten} replaced, ${res.skipped} left as they were.`);
    } catch (e) { alert(`Could not restore: ${e.message}`); }
    el.value = '';
  },
};
