# benchbook

A bench-side notebook for library prep and hybrid capture: master-mix maths, step checklists with timers, QC, a UDI plate map, and graphs across batches.

**Use it:** <https://ahumanbrain.github.io/benchbook/> (nothing to install; your data stays in your browser).

![Every library from every batch, with the median and where the protocol changed](docs/overview.png)

## What it does

**Bench.** Enter the number of reactions and the overage, and every volume is worked out. Tick steps off, start timers for binds and incubations, add notes (observation, deviation, error, idea). Print the Plan tab as a bench sheet.

![A step on the bench: master mix table, tick box and note](docs/bench.png)

**QC and plate.** Paste NanoDrop or Qubit readings and low or odd values are flagged. Lay libraries on a 96-well UDI plate (it skips wells that were used or flagged) and get the µL of each library for an equal-mass hyb pool.

![UDI plate with pools, flagged wells and wells used by other batches](docs/plate.png)

**Graphs.** One bar per library within a batch, and every library from every batch on the Overview.

![One bar per library, coloured by hyb pool](docs/graphs.png)

**Compare.** Pick two batches and see what changed, in plain words: settings, volumes, times, steps, QC and notes.

![Protocol changes between two batches](docs/compare.png)

**Protocols.** Copy a built-in protocol and edit it in the page, with a live preview. Each save is a new revision, and past batches keep the revision they used.

![The protocol editor](docs/editor.png)

**Light and dark.** The button at the top right switches theme and remembers your choice.

![Dark mode](docs/dark.png)

## Your data

- Everything is stored in your browser, on one device. Nothing is uploaded.
- **Back it up:** the chip at the top right shows whether you are safe. Pick a folder (Chrome or Edge) and every change is saved there, or export everything to one file.
- The 14 batches from the lab workbook are already loaded, so there is data to look at. They are normal batches: edit or delete them freely.

## Run it yourself

It is a static site with no build step. Serve the folder (browsers will not load it from `file://`):

```bash
python3 -m http.server 8000
```

then open <http://localhost:8000>. To host it, turn on GitHub Pages for the `main` branch.

## More

[docs/details.md](docs/details.md) covers backup in detail, how the workbook was imported (and the data problems found), the protocol file format, and the tests.
