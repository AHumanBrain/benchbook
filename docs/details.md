# Details

The short version is in the [README](../README.md). This page has the detail.

## Backup

Open the **Backup** page (the chip in the header).

- **Auto-save to a folder**: pick a folder once and benchbook writes `benchbook-backup.json` there after every change. Put the folder in Dropbox, OneDrive or iCloud Drive to keep it off the machine too. Needs Chrome or Edge on a computer. After a browser restart the browser asks for one click to continue (it will not write to a folder without it).
- **Safety check**: before every write, the file in the folder is read. If it holds batches or protocols this browser does not have (a new browser, or cleared data), auto-save pauses instead of overwriting it, and you choose: add the folder's data to this browser, overwrite the folder, or stop. Things you deleted on purpose do not trigger this.
- **Export everything / Restore**: one JSON file with all batches, protocols and plates. Restoring adds what is missing and asks before replacing a batch that exists in both.

Export a single batch from its Batch info tab.

## Your workbook, already loaded

`data/seed.json` holds the lab workbook's 14 batches (8 library preps and 6 hyb and captures: dates, master-mix overage, NanoDrop and Qubit readings, UDI wells, ticked steps and notes). They load the first time the app opens, so there is data to explore straight away.

- They are ordinary batches: edit them, add notes, delete them. Edited batches are never replaced, and a batch you delete stays deleted. **Restore workbook batches** (on the home page) brings back any you removed.
- Imported batches are marked "from workbook" until you change them. Backups are aware of this: a backup folder that holds your edited version of an imported batch is never overwritten by a fresh copy.
- What was left out on purpose: personal names, and purely administrative steps (LIMS, labels, e-mails). Ticked steps carry the date only (the workbook has no times).
- Protocol changes recorded in the workbook are kept: from batch 4 the bead drying step is dropped and elution is 20 µL of water; from batch 5 the adapter is master-mixed with the ligation (50 µL dispense). Batches 1 to 3 used the built-in numbers. Use **Compare** to see them.
- **Data problems found while importing**, handled as follows: batch 6's NanoDrop table (and its hyb, capture and sequencing dates) was an exact stale copy of the RNA isolation tab, so none of it is imported and batch 6 is shown as planned; batch 4's "nanodrop/BR" ratio column in the workbook is BR ÷ NanoDrop while "nanodrop/HS" is NanoDrop ÷ HS, so the note says NanoDrop reads about 1.2× Qubit BR (not 0.9×); hyb batch 2 lists the sample ID `SI_44453-58` twice (the workbook notes pools 3 and 4 went into one tube), kept as recorded with the duplicate warning; batch 3's sequencing date ("2609XX") is blank.
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

## Tests

```bash
node --test test/*.test.mjs
```

The tests cover the arithmetic (for example 24 reactions at +10% gives 264, 242 and 22 µL for the first strand mix), the QC and plate logic, the protocol diff and validation, the backup safety checks, and the imported workbook data (counts, exact readings, dates, protocol changes).

## Not built yet

- Offline use (a service worker) and syncing across devices
- Sequencing run metrics (NovaSeq InterOp) in a run dashboard
