# Details

The short version is in the [README](../README.md). This page has the detail.

## Charts

Every chart follows the same rules, so batches can be read side by side.

- **Dots, not bars.** A library has one reading, so each is a dot (with a thin stem to the axis). The dots keep the same size whether a batch has 3 libraries or 25, and the Overview uses the same dots.
- **One colour per hyb pool**, everywhere: on the plate, in the pooling plan, in each batch's graph and on the Overview. In a hyb batch, reading *n* is pool *n* (when the hyb is linked to a prep that has pools). Libraries without a pool are grey.
- **A ring means outside the QC thresholds.** The fill never changes, so the pool colour is never lost.
- **Grouped by pool**, with a bracket and the pool number under each group, and library names angled the same way in every chart.
- **Median and threshold** are labelled in the right margin, where they cannot sit on a dot.
- **Shared scale.** Concentration charts use one scale across batches of the same measurement (prep readings together, post-capture readings together), so a dot at the same height is the same concentration. Untick *Same scale as the other batches* to zoom in on one batch.

## Runs, links and the next batch

- **Links.** A batch can be linked to the batches it belongs with (a prep and its hyb). Links are two-way, shown under each batch's title, and managed on the Batch info tab. The home page groups linked batches into one card with a prep → hyb → capture → sequencing date strip. Batches are told apart as *library prep* or *hyb & capture* by the protocol they use.
- **Hyb from a prep.** On a prep's Batch info tab, *Create the hyb & capture batch from this prep* makes one hyb per pool, copies the dates, uses the same protocol as your latest hyb (else the built-in one), and links both ways. The hyb's Bench and Plan tabs open with the prep's pooling plan. It needs pools (set on the prep's Plate & pools tab).
- **Next batch.** On the *Batch info* tab, *Start the next batch* copies protocol revision, overage, thermocycler and plate settings, names the batch by counting up the last number in the name, sets today as the prep date, and creates `Sample 1…n` libraries on the next free wells of the same index plate: after this batch's last well, skipping wells other batches used and flagged wells. If there is not enough room after the last well, the gaps are filled from the top of the plate. You can also pick one of your own protocol revisions instead of the batch's.
- **Undo.** Deletes (a batch, a note, a QC set, a protocol, a protocol step or section, a well flag, a link) happen at once and show an *Undo* button for a few seconds. Native pop-ups are only used where nothing can be undone: overwriting the backup folder, replacing a batch from a backup file, and discarding unsaved protocol edits.

## Backup

Open the **Backup** page (the chip in the header).

- **Auto-save to a folder**: pick a folder once and benchbook writes `benchbook-backup.json` there after every change. Put the folder in Dropbox, OneDrive or iCloud Drive to keep it off the machine too. Needs Chrome or Edge on a computer. After a browser restart the browser asks for one click to continue (it will not write to a folder without it).
- **Safety check**: before every write, the file in the folder is read. If it holds batches or protocols this browser does not have (a new browser, or cleared data), auto-save pauses instead of overwriting it, and you choose: add the folder's data to this browser, overwrite the folder, or stop. Things you deleted on purpose do not trigger this.
- **Export everything / Restore**: one JSON file with all batches, protocols and plates. Restoring adds what is missing and asks before replacing a batch that exists in both.

Export a single batch from its Batch info tab.

## Your workbook, already loaded

`data/seed.json` holds the lab workbook's 14 batches (8 library preps and 6 hyb and captures: dates, master-mix overage, NanoDrop readings, UDI wells, ticked steps and notes). They load the first time the app opens, so there is data to explore straight away.

- They are ordinary batches: edit them, add notes, delete them. Edited batches are never replaced, and a batch you delete stays deleted. **Restore workbook batches** (on the home page) brings back any you removed.
- Imported batches count as untouched until you change them. Backups are aware of this: a backup folder that holds your edited version of an imported batch is never overwritten by a fresh copy.
- What was left out on purpose: personal names, purely administrative steps (LIMS, labels, e-mails), and the Qubit readings (batch 4's tab compared NanoDrop with two Qubit assays; that was a check on the NanoDrop, so only the NanoDrop readings are imported). Ticked steps carry the date only (the workbook has no times).
- Protocol changes recorded in the workbook are kept: from batch 4 the bead drying step is dropped and elution is 20 µL of water; from batch 5 the adapter is master-mixed with the ligation (50 µL dispense). Batches 1 to 3 used the built-in numbers. Use **Compare** to see them.
- **Data problems found while importing**, handled as follows: batch 6's NanoDrop table (and its hyb, capture and sequencing dates) was an exact stale copy of the RNA isolation tab, so none of it is imported and batch 6 is shown as planned; hyb batch 2 lists the sample ID `SI_44453-58` twice (the workbook notes pools 3 and 4 went into one tube), kept as recorded with the duplicate warning; batch 3's sequencing date ("2609XX") is blank.
- **Read twice is still one library.** In batch 1, preR23 was read a second time (`preR23_2`) to check for a bubble in the NanoDrop spot. The readings matched (18.7 and 18.5 ng/µL), so it is one library: the first reading is used, the second is recorded in a note and in a warning on the QC tab, and it is not a 25th reading.
- Pools: libraries are grouped in consecutive sets of the workbook's plex (3, or 6 for the DNase screen). That matches its pool IDs (`SI_44371-44373` is three consecutive libraries). The RNA isolation test's pools are not assigned because the workbook does not say which libraries went where.

To rebuild the file from the workbook (needs `openpyxl`; the workbook itself is not in the repo): `python3 scripts/seed/build_seed.py workbook.xlsx > data/seed.json`.

## Protocols are data

Protocols live in `protocols/*.json`, not in code. Two ship with the repo:

| File | Protocol |
|---|---|
| `kapa_rna_hyperprep.json` | KAPA RNA HyperPrep, cfRNA, no fragmentation, UDI adapters |
| `xgen_hyb_wash_v3.json` | IDT xGen Hybridization and Wash v3, multiplexed capture |

The volumes follow one lab's workbook, **not** the vendor manuals. Check them against your kit insert before relying on them.

A protocol is a list of sections, each a list of steps. Step types:

| `type` | Fields |
|---|---|
| `mix` | `input` (the sample, optional), `components` (master-mixed, overage applied), `dispense_vol` (override), `dispense: false`, `add` (per-reaction additions, no overage), `note` |
| `thermocycle` | `program`: steps `{name, temp_c, duration_s}` (`null` = open hold) or `{cycles, steps}`; `lid_c`; `note` |
| `cleanup` | bead cleanup: `sample`, `sample_vol`, `bead`, `bead_vol`, `bind_min`, `wash`, `dry_min` (0 = no drying), `elute_vol`, `elute_buffer` (optional, default "Tris (5 mM) or water"), `elute_min`, `transfer_vol`. Expands into five tickable steps. |
| `step` | `text`, optional `timer_min`, `per_rxn_vol` (shows total for the batch), `per_label`, `note` |

Most people never need to touch these files: copy a protocol on the **Protocols** page and edit it in the browser. Your protocols are stored in the browser (and included in backups); **Export** gives you a JSON file you can commit here. To ship one with the repo, drop the file in `protocols/` and add its id to `protocols/index.json`. A batch stores a snapshot of the protocol it was started from, so editing a protocol never changes past batches.

## Developing

After changing anything in `src/`, `data/` or `protocols/`, run:

```bash
node scripts/stamp.mjs
```

It adds a version to each script's URL in `index.html` and writes `build.json`. Without it, browsers may keep running a cached copy of the old code for up to ten minutes (that is how long GitHub Pages lets them). With it, a normal reload picks up the change, and a page left open shows a "newer version is available" message with a Reload button. A test fails if the stamp is out of date, so CI catches a forgotten run.

### Safety of files you open

A backup, a folder file or a batch someone sends you is treated as untrusted. Three layers, so one slip is not enough:
1. **Checked on the way in** (`parseBackup`, `checkBatch`): ids may only be letters, digits and `- _ .`, counts must be numbers in range, otherwise the file is refused with a plain message.
2. **Escaped on the way out**: every name, id and number written into a page goes through `esc()` or `Number()`.
3. **A Content-Security-Policy** in `index.html` (written by `scripts/stamp.mjs`): only scripts from this site and three hash-listed inline scripts may run, so injected markup cannot execute. If you add an inline script, add it to the list in `stamp.mjs`.


## Tests

```bash
node --test test/*.test.mjs
```

The tests cover the arithmetic (for example 24 reactions at +10% gives 264, 242 and 22 µL for the first strand mix), the QC and plate logic, the protocol diff and validation, the backup safety checks, and the imported workbook data (counts, exact readings, dates, protocol changes).

## Not built yet

- Offline use (a service worker) and syncing across devices
- Sequencing run metrics (NovaSeq InterOp) in a run dashboard
