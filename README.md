# benchbook

A bench-side notebook for library prep and hybrid capture. It turns a spreadsheet workbook into something you can actually use with gloves on.

- **Plan**: enter the number of reactions and the master-mix overage. Every volume updates, including per-reaction additions that get no overage. Print it as a bench sheet.
- **Bench**: tick steps off, start timers for the binds, drys and incubations (with an audible alert), and see thermocycler programs on screen. Each tick is timestamped.
- **Notes**: attach a note to any step and tag it *observation*, *deviation*, *error* or *idea*. The Notes tab collects them, so lessons stop living in a spreadsheet's right-hand column.
- **Batch info**: run lineage (prep, hyb, capture, sequencing dates), thermocycler, and which batches were co-processed.

Everything is stored in your browser (localStorage). Nothing is uploaded. Export a batch to a JSON file to keep a copy, or to move it to another device.

## Run it

It is a static site: no build step, no dependencies. Browsers will not load the protocol files from `file://`, so serve the folder:

```bash
python3 -m http.server 8000
```

then open <http://localhost:8000>. To host it, enable GitHub Pages for the `main` branch root.

Press **Load example batch** on the home page to look around. The example is synthetic.

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
| `cleanup` | bead cleanup: `sample`, `sample_vol`, `bead`, `bead_vol`, `bind_min`, `wash`, `dry_min`, `elute_vol`, `elute_min`, `transfer_vol`. Expands into five tickable steps. |
| `step` | `text`, optional `timer_min`, `per_rxn_vol` (shows total for the batch), `per_label`, `note` |

To add a protocol, drop a JSON file in `protocols/` and add its id to `protocols/index.json`. A batch stores a snapshot of the protocol it was started from, so editing a protocol never changes past batches.

## Check

```bash
node --test test/*.test.mjs
```

The tests check the master-mix arithmetic against the original workbook (for example 24 reactions at +10% gives 264, 242 and 22 µL for the first strand mix).

## Not built yet

- QC import (paste NanoDrop, Qubit or TapeStation output; flag 260/280 and 260/230; pooling math for a 1 µg hyb)
- Index plate and pool map (UDI wells, which library went into which hyb)
- A diff of "what changed since the last batch", and cross-batch yield trends
- Offline use (service worker) and syncing across devices
- Sequencing run metrics (NovaSeq InterOp) in a run dashboard
