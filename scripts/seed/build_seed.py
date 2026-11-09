#!/usr/bin/env python3
"""Build data/seed.json from the lab workbook (library prep + hybrid capture tabs).

    python3 scripts/seed/build_seed.py path/to/workbook.xlsx > data/seed.json

Needs openpyxl. The workbook itself is not kept in the repo. Each tab becomes one batch: its dates, master-mix
overage, NanoDrop/Qubit readings, UDI wells, ticked steps and notes. Notes are rewritten by hand below (no personal
names), and purely administrative rows (LIMS, labels, e-mails) are left out. Decisions about stale data are in the
comments: tabs copied forward from an earlier batch keep their old readings, which must not be imported.
"""
import copy, json, re, sys
import openpyxl

ROOT = __file__.rsplit('/scripts/', 1)[0]
KAPA = json.load(open(f'{ROOT}/protocols/kapa_rna_hyperprep.json'))
XGEN = json.load(open(f'{ROOT}/protocols/xgen_hyb_wash_v3.json'))
wbv = openpyxl.load_workbook(sys.argv[1], data_only=True)
TABS = {ws.title.strip(): ws for ws in wbv}
LINEAGE = re.compile(r'^(library prep|hyb|cap|sequence)\b', re.I)


def ymd(s):
    m = re.fullmatch(r'(\d\d)(\d\d)(\d\d)', s)
    return f'20{m[1]}-{m[2]}-{m[3]}' if m else None


def nanodrop_hdr(ws):
    for row in ws.iter_rows():
        for c in row:
            if c.value == 'Sample ID':
                return c.row
    return None


def blocks(ws):
    """Protocol part of a tab as blocks started by a 'Component' or 'Step' header, plus the lineage lines."""
    h = nanodrop_hdr(ws)
    upto = h - 1 if h else ws.max_row
    out, cur, lineage = [], None, []
    for r in range(4, upto + 1):
        a, b, c, d, e = [ws.cell(r, k).value for k in range(1, 6)]
        if all(x is None for x in (a, b, c, d, e)):
            continue
        if isinstance(a, str) and LINEAGE.match(a):
            lineage.append((r, a, b))
            continue
        if a in ('Component', 'Step'):
            cur = {'type': a, 'rows': [], 'head': (r, a, b, c, d, e)}
            out.append(cur)
        elif cur is not None:
            cur['rows'].append((r, a, b, c, d, e))
    return out, lineage


def lineage_info(lineage):
    """prep dates, hyb date, capture date, sequencing date and thermocyclers, ignoring dates that are not plausible."""
    prep = hyb = cap = seq = None
    cyc = {}
    for _, a, b in lineage:
        low = a.lower()
        dates = [ymd(x) for x in re.findall(r'\d{6}', a)]
        if low.startswith('library prep'):
            prep = dates
        elif low.startswith('hyb') and 'started' not in low:
            hyb = dates[0] if dates else None
        elif low.startswith('cap'):
            cap = dates[0] if dates else None
        elif low.startswith('sequence'):
            seq = dates[0] if dates else None
        if b:
            cyc[low.split()[0]] = str(b)
    return {'prep': prep or [], 'hyb': hyb, 'cap': cap, 'seq': seq, 'cyc': cyc}


def cycler(name):
    n = (name or '').lower()
    return 'Applied Biosystems' if 'applied' in n else 'Bio-Rad deep well' if 'bio-rad' in n else ''


# ----- which protocol step each sheet row belongs to ---------------------------------------------------------------
KMIX = {0: '0.0', 2: '1.0', 4: '2.0', 6: '3.0', 9: '5.0'}
KPROG = {1: '0.1', 3: '1.1', 5: '2.1', 7: '3.1', 10: '5.1'}


def clean_sub(label):
    s = str(label).lower()
    if s.startswith('bind') or 'product' in s or 'beads' in s:
        return 0
    if 'wash' in s:
        return 1
    if s.startswith('dry') or 'remove ethanol' in s:
        return 2
    if s.startswith('elute'):
        return 3
    if s.startswith('transfer'):
        return 4
    return None


def kapa_done(bl):
    done = set()
    for i, b in enumerate(bl):
        rows = b['rows']
        if i in KMIX and any(r[4] == 'x' for r in rows):
            done.add(KMIX[i])
        elif i in KPROG and any(r[4] == 'x' for r in rows):
            done.add(KPROG[i])
        elif i in (8, 11):
            for r in rows:
                if r[4] == 'x' and clean_sub(r[1]) is not None:
                    done.add(f"{'4.0' if i == 8 else '6.0'}.{clean_sub(r[1])}")
    if '5.1' not in done and any(k.startswith('6.0') for k in done):
        done.add('5.1')   # the PCR program rows are never ticked; the cleanup after it is
    return done


def xgen_done(bl):
    done = set()
    def x(rows):
        return any(r[4] == 'x' for r in rows)
    b = bl
    for r in b[0]['rows']:
        if r[4] == 'x':
            done.add('0.1' if str(r[1]).lower().startswith('dry') else '0.0')
    for r in b[1]['rows']:
        if r[4] == 'x':
            done.add('1.1' if str(r[1]).lower().startswith('incubate') else '1.0')
    if x(b[2]['rows']): done.add('1.2')
    if x(b[3]['rows']): done.add('2.0')
    if any(r[4] == 'x' and 'dynabeads' in str(r[1]).lower() for r in b[4]['rows']): done.add('2.1')
    adds = 0
    for r in b[5]['rows']:
        a = str(r[1]).lower() if isinstance(r[1], str) else r[1]
        if r[4] != 'x':
            continue
        if a == 'add':
            adds += 1
            done.add('2.2' if adds == 1 else '2.3')
        elif isinstance(a, str) and 'repeat for a total' in a: done.add('2.2')
        elif isinstance(a, str) and 'dispense 18' in a: done.add('2.3')
        elif a == 1200: done.add('3.0')
        elif isinstance(a, str) and 'stringent' in a: done.add('3.1')
        elif a == 54: done.add('3.2')
        elif isinstance(a, str) and 'wash buffer 1' in a: done.add('3.3')
        elif isinstance(a, str) and 'wash buffer 2' in a: done.add('3.4')
        elif a == 60: done.add('3.5')
        elif isinstance(a, str) and 'water' in a: done.add('3.6')
    if x(b[6]['rows']): done.add('4.0')
    for r in b[8]['rows']:
        if r[4] == 'x' and clean_sub(r[1]) is not None:
            done.add(f'4.2.{clean_sub(r[1])}')
    if '4.1' not in done and any(k.startswith('4.2') for k in done):
        done.add('4.1')
    return done


# ----- protocol variants: only what really differs in the sheets -----------------------------------------------------
def variant(base, rev, edit=None):
    p = copy.deepcopy(base)
    p['revision'] = rev
    p.pop('custom', None)
    if edit:
        edit(p)
    return p


def kapa_v2(p):   # batch 4: no drying, elute in 20 uL water (both cleanups)
    for sec in p['sections']:
        for st in sec['steps']:
            if st['type'] == 'cleanup':
                st.update(dry_min=0, elute_vol=20, elute_buffer='water')


def kapa_v3(p):   # batch 5 on: adapter master-mixed into the ligation, dispense 50 uL
    kapa_v2(p)
    lig = p['sections'][2]['steps'][0]
    lig['components'].append({'name': 'Adapter (15 uM)', 'vol': 5})
    lig['dispense_vol'] = 50
    lig.pop('add', None)
    lig['note'] = 'Adapter is master-mixed with the ligation components (from batch 5).'


def xgen_v2(p):   # batch 4 on: AMPure cleanup without drying, elute in 20 uL water
    for sec in p['sections']:
        for st in sec['steps']:
            if st['type'] == 'cleanup':
                st.update(dry_min=0, elute_vol=20, elute_buffer='water')


PROTOCOLS = {
    'kapa_v1': variant(KAPA, 1), 'kapa_v2': variant(KAPA, 2, kapa_v2), 'kapa_v3': variant(KAPA, 3, kapa_v3),
    'xgen_v1': variant(XGEN, 1), 'xgen_v2': variant(XGEN, 2, xgen_v2),
}


# ----- QC tables -----------------------------------------------------------------------------------------------------
def unique_names(names, base):
    seen = {}
    for n in names:
        seen[n] = seen.get(n, 0) + 1
    count = {}
    out = []
    for n in names:
        if seen[n] > 1:
            count[n] = count.get(n, 0) + 1
            out.append(f'{n} {count[n]}')
        else:
            out.append(n)
    return out


def std_rows(ws, blank_prefix, make_unique=False):
    """The usual NanoDrop export: '#', Sample ID, ..., Nucleic Acid, Unit, ..., 260/280, 260/230."""
    r0 = nanodrop_hdr(ws)
    hd = {str(ws.cell(r0, c).value).strip(): c for c in range(1, ws.max_column + 1) if ws.cell(r0, c).value is not None}
    rows, blanks = [], 0
    r = r0 + 1
    while any(ws.cell(r, c).value is not None for c in range(1, ws.max_column + 1)):
        name = ws.cell(r, hd['Sample ID']).value
        num = ws.cell(r, hd['#']).value if '#' in hd else len(rows) + 1
        if name is None or str(name).strip() == '':
            name = f'{blank_prefix} {int(num)}'
            blanks += 1
        dt = ws.cell(r, hd['Date and Time']).value
        conc = ws.cell(r, hd['Nucleic Acid']).value
        rows.append({'name': str(name).strip(), 'conc': float(conc), 'rawConc': f'{conc:g}', 'unit': 'ng/µL', 'nM': None,
                     'r280': float(ws.cell(r, hd['260/280']).value), 'r230': float(ws.cell(r, hd['260/230']).value),
                     'date': dt.strftime('%Y-%m-%d %H:%M') if hasattr(dt, 'strftime') else ''})
        r += 1
    warnings = []
    if blanks:
        warnings.append(f'the Sample ID column was blank for {blanks} row(s): named "{blank_prefix} 1", "{blank_prefix} 2"… from the # column.')
    if make_unique:
        names = [x['name'] for x in rows]
        if len(set(names)) != len(names):
            for row, n in zip(rows, unique_names(names, '')):
                row['name'] = n
            warnings.append('sample names repeated in the workbook (one per pool of a kind); numbered here to keep them apart.')
    dup = sorted({x['name'] for x in rows if [y['name'] for y in rows].count(x['name']) > 1})
    if dup:
        warnings.append(f'duplicate sample names: {", ".join(dup)}')
    first = next((x['date'] for x in rows if x['date']), '')
    return rows, warnings, first.replace(' ', 'T') if first else ''


def table(rows, warnings, label, qid, when, fmt='nanodrop'):
    return {'id': qid, 'label': label, 't': when, 'format': fmt, 'warnings': warnings, 'rows': rows}


def simple_rows(ws, r0, name_col, conc_col, r280_col, r230_col, count, prefix):
    rows = []
    for i in range(count):
        r = r0 + 1 + i
        name = ws.cell(r, name_col).value if name_col else None
        c = ws.cell(r, conc_col).value
        rows.append({'name': str(name).strip() if name else f'{prefix} {i + 1}', 'conc': float(c), 'rawConc': f'{c:g}', 'unit': 'ng/µL', 'nM': None,
                     'r280': float(ws.cell(r, r280_col).value) if r280_col else None,
                     'r230': float(ws.cell(r, r230_col).value) if r230_col else None, 'date': ''})
    return rows


# ----- notes (rewritten by hand, no personal names) --------------------------------------------------------------------
PIP = ('0.0', 'observation', 'Pipetted 10-20x to resuspend the RNA pellet.')
MM = ('2.0', 'idea', 'Consider master-mixing all of the ligation components.')
RED = ('2.1', 'idea', 'Consider reducing the ligation time back down.')
HOLD = ('4.0.3', 'observation', 'Can elute overnight at 4 °C.')
OBI = ('4.0.4', 'idea', 'Consider on-bead indexing PCR.')
ICE = ('2.0', 'observation', 'Master mix in hand, samples in an ice block.')
BIND = ('4.0.0', 'idea', 'Consider reducing the bind time.')
INDIV0 = ('0.0', 'observation', "Blockers added individually, on a colleague's advice.")
INDIV1 = ('1.0', 'observation', "Hybridization buffer and panel added individually, on a colleague's advice.")

NOTES = {
    'KAPA RNA HyperPrep - batch 1': [PIP, ('0.0', 'idea', 'Lower the master-mix overage to 5%.'), ('2.1', 'idea', 'Ligation can be as short as 15 minutes.'),
        ('5.0', 'deviation', 'Noticed lower volume of indexing primers in plate positions D1-D8 than in the rest of the row.')],
    'KAPA RNA HyperPrep - batch 2': [PIP, MM, RED, ('3.0', 'observation', 'Did I skip a tube? The NanoDrop should show it.'),
        ('4.0.3', 'deviation', 'Eluted overnight at 4 °C.'), ('5.0', 'observation', 'Index overlap check with another user of the index plate: some overlapping.'),
        ('6.0.4', 'observation', "High quants mean USER wasn't forgotten.")],
    'KAPA RNA HyperPrep - DNase scre': [PIP, MM, ("2.0", 'observation', "Hope I didn't forget to add adapter around sample 4."), RED,
        ('3.0', 'observation', "Interrupted during USER: hope I didn't miss any reactions."), HOLD],
    'KAPA RNA HyperPrep - batch 3': [PIP, MM, RED, ('4.0.3', 'deviation', 'Eluted this batch for 30 minutes.'), HOLD],
    'KAPA RNA HyperPrep - batch 4': [PIP, MM, RED, ('3.0', 'observation', 'I always feel like I forget a tube, but it has yet to happen.'), BIND,
        ('4.0.3', 'deviation', 'Eluted overnight at 4 °C.'), OBI,
        # the workbook's 'nanodrop/HS' column is NanoDrop / HS (mean 2.06) but its 'nanodrop/BR' column is BR / NanoDrop (mean 0.87),
        # so its note "NanoDrop reads 0.9x Qubit BR" is inverted: NanoDrop / BR averages 1.17.
        ('6.0.4', 'observation', 'NanoDrop vs Qubit on these 24 libraries: NanoDrop reads about 2.1x Qubit dsDNA HS and about 1.2x Qubit dsDNA BR (mean of per-library ratios, n=24). The workbook column "nanodrop/BR" is actually BR/NanoDrop (0.87).'),
        ('6.0.4', 'observation', 'Qubit assay mix: 5970 µL buffer + 30 µL dye; 1 µL of library per assay.')],
    'KAPA RNA HyperPrep - batch 5': [PIP, ('2.0', 'observation', 'Master-mixed the ligation components with the adapter.'), ICE, RED,
        ('4.0.0', 'deviation', 'Bind took more like 50 minutes.'), OBI,
        ('4.0.4', 'observation', 'Resumed on 2026-10-14 after the NEB and Norgen RNA isolation benchmarking on 2026-10-13.'),
        ('6.0.0', 'idea', 'Bioanalyze a few libraries to check for adapter dimers.')],
    'KAPA RNA HyperPrep - RNA isolat': [PIP, ('2.0', 'observation', 'Master-mixed the ligation components with the adapter.'), ICE, RED, BIND,
        ('4.0.3', 'deviation', 'Elution took more like 1 hour.'), OBI],
    # batch 6: no step is ticked and its readings are a stale copy of another tab, so its notes are carried-over template text: not imported
    'KAPA RNA HyperPrep - batch 6': [],
    'IDT xGen Hyb and Wash v3 - batc': [('1.2', 'observation', 'In at 5 pm on 2026-08-11.'), ('3.0', 'observation', 'Captured at 10 am on 2026-08-12 (17 h hybridization).'),
        ('4.1', 'error', 'Pool 2 lid opened during PCR and 20 µL of that reaction evaporated. Added 20 µL water and proceeded to the bead cleanup.')],
    'Sheet2': [('0.0', 'observation', 'Consolidated all reagent aliquots.'),
        ('0.1', 'observation', 'Dried libraries for 45 min, added the blocker mix, dried for another 45 min. Is this damaging?'),
        ('1.2', 'observation', 'In at 5 pm on 2026-08-18.'), ('3.0', 'observation', 'Captured at 10 am on 2026-08-19 (17 h hybridization).'),
        ('4.2.4', 'error', 'Accidentally added pools 3 and 4 into the same tube.')],
    'IDT xGen Hyb and Wash v3 - DNas': [('0.0', 'observation', 'Using 1 µg of library per hyb.'), ('1.2', 'observation', 'Hyb started at 3:15 pm on 2026-09-10.'),
        ('3.0', 'observation', 'Capture started at 9:45 am on 2026-09-11 (18.5 h hybridization).')],
    'Sheet3': [('1.0', 'idea', 'Reduce the master-mix overage to 5%.'), ('1.2', 'observation', 'Hyb started at 5:00 on 2026-09-16.'),
        ('3.0', 'observation', 'Capture started at 10:30 on 2026-09-17.')],
    'xGen Hyb and Wash v3 - batch 4': [INDIV0, INDIV1, ('1.2', 'observation', 'Hyb started at 3:40 pm on 2026-10-05.'),
        ('3.0', 'observation', 'Capture started at 9:20 am on 2026-10-06.'), ('4.0', 'idea', 'Lower the PCR master-mix overage to 5%.')],
    'xGen Hyb and Wash v3 - batch 5': [INDIV0, INDIV1, ('1.1', 'observation', 'Mixed by pipetting this time.'),
        ('1.2', 'observation', 'Hyb started at 4:30 pm on 2026-10-19.'), ('3.0', 'observation', 'Capture started at 10:05 am on 2026-10-20.'),
        ('3.6', 'idea', 'Increase to 23.8 µL water.'), ('4.0', 'idea', 'Just master-mix the KAPA mix and primers; decrease the dispense to 26.2 µL.')],
}


def build_state(done, notes, date_for, stage_for):
    state = {}
    for key in sorted(done, key=lambda k: [int(p) for p in k.split('.')]):
        state[key] = {'done': date_for(key), 'timer': None, 'notes': []}
    for key, tag, text in notes:
        state.setdefault(key, {'done': None, 'timer': None, 'notes': []})['notes'].append({'t': date_for(key), 'tag': tag, 'text': text})
    return state


def pools(n, plex):
    return [i // plex + 1 for i in range(n)]


def make_plate(names, wells, plex, qc_id, plate_id):
    return {'plateId': plate_id, 'start': 'A1', 'order': 'row', 'skipFlagged': True, 'skipUsed': True, 'plex': plex, 'targetNg': 1000,
            'availUl': 20, 'qcSetId': qc_id,
            'samples': [{'name': n, 'well': (wells[i] if wells else None), 'pool': p} for i, (n, p) in enumerate(zip(names, pools(len(names), plex)))]}


def wells_between(first, last):
    out, started = [], False
    for r in 'ABCDEFGH':
        for c in range(1, 13):
            w = f'{r}{c}'
            started = started or w == first
            if started:
                out.append(w)
            if w == last:
                return out
    return out


PLATE = 'seed-udi-plate'


def kapa_batch(tab, bid, name, variant_id, plex, wells=None, cohyb='', qc_builder=None, pooled=True):
    ws = TABS[tab]
    bl, lin = blocks(ws)
    li = lineage_info(lin)
    prep = li['prep']
    d1 = prep[0] if prep else None
    d2 = prep[1] if len(prep) > 1 else d1
    if bid == 'seed-b1-prep':
        late_from = 6        # a day marker (260811) sits at the second cleanup of batch 1
    else:
        late_from = 5
    def date_for(key):
        sec = int(key.split('.')[0])
        return d2 if (sec >= late_from and d2) else d1
    # stale dates: a hyb/capture/sequencing date before the prep started was copied forward from an older tab
    hyb, cap, seq = li['hyb'], li['cap'], li['seq']
    if hyb and d1 and hyb < d1: hyb = cap = seq = None
    cyc = li['cyc']
    pc, hc = cycler(cyc.get('library')), cycler(cyc.get('hyb'))
    parts = [pc] if (pc and (not hc or not hyb or hc == pc)) else [f'{pc} (prep)', f'{hc} (hyb, capture)']
    n = ws['B2'].value
    sets, plate = [], make_plate([], None, plex, None, None)
    if qc_builder:
        sets = qc_builder(ws)
    state = build_state(kapa_done(bl), NOTES[tab], date_for, None)
    if sets:
        names = [r['name'] for r in sets[0]['rows']][:n if tab.endswith('batch 1') else len(sets[0]['rows'])]
        if bid == 'seed-b1-prep':
            names = names[:24]
        plate = make_plate(names, wells, plex, sets[0]['id'], PLATE if wells else None)
        if not pooled:
            for smp in plate['samples']:
                smp['pool'] = None
    return {
        'id': bid, 'name': name, 'protocol': variant_id, 'n': int(n), 'overagePct': 10 if bid == 'seed-b1-prep' else 5,
        'created': f'{d1}T12:00:00.000', 'seed': True,
        'info': {'prep': d1, 'hyb': hyb or '', 'cap': cap or '', 'seq': seq or '', 'thermocycler': '; '.join(p for p in parts if p), 'cohyb': cohyb},
        'state': state, 'qc': {'sets': sets}, 'plate': plate,
    }


def xgen_batch(tab, bid, name, variant_id, prep_tab, qc_set, cohyb=''):
    ws = TABS[tab]
    bl, _ = blocks(ws)
    li = lineage_info(blocks(TABS[prep_tab])[1])
    hyb, cap, seq = li['hyb'], li['cap'], li['seq']
    cyc = li['cyc']
    def date_for(key):
        return hyb if int(key.split('.')[0]) < 2 else cap
    state = build_state(xgen_done(bl), NOTES[tab], date_for, None)
    return {
        'id': bid, 'name': name, 'protocol': variant_id, 'n': int(ws['B2'].value), 'overagePct': 10, 'created': f'{hyb}T12:00:00.000', 'seed': True,
        'info': {'prep': '', 'hyb': hyb, 'cap': cap, 'seq': seq or '', 'thermocycler': cycler(cyc.get('hyb')), 'cohyb': cohyb},
        'state': state, 'qc': {'sets': [qc_set]}, 'plate': make_plate([], None, 3, None, None),
    }


def std_set(label, qid, blank_prefix='Sample', make_unique=False):
    def build(ws):
        rows, warnings, when = std_rows(ws, blank_prefix, make_unique)
        return [table(rows, warnings, label, qid, when)]
    return build


def dnase_prep(ws):
    r0 = nanodrop_hdr(ws)
    n = 0
    while ws.cell(r0 + 1 + n, 1).value is not None:
        n += 1
    rows = simple_rows(ws, r0, 1, 2, 3, 4, n, 'Sample')
    return [table(rows, [], 'Pre-capture libraries', 'q-dnase-prep', '2026-09-08', 'table')]


def b4_sets(ws):
    n = 24
    r0 = 94
    mk = lambda col: simple_rows(ws, r0, None, col, None, None, n, 'Sample')
    when = '2026-10-02'
    return [
        table(mk(4), [], 'Pre-capture libraries', 'q-b4-nd', when, 'table'),
        table(mk(5), [], 'Pre-capture libraries (Qubit HS)', 'q-b4-hs', when, 'table'),
        table(mk(6), [], 'Pre-capture libraries (Qubit BR)', 'q-b4-br', when, 'table'),
    ]


def rna_iso(ws):
    r0 = 95   # header row of the readings table in this tab
    rows = []
    for i in range(12):
        r = r0 + 1 + i
        c = ws.cell(r, 5).value
        rows.append({'name': str(ws.cell(r, 2).value), 'conc': float(c), 'rawConc': f'{c:g}', 'unit': 'ng/µL', 'nM': None,
                     'r280': float(ws.cell(r, 9).value), 'r230': float(ws.cell(r, 10).value), 'date': ws.cell(r, 4).value.strftime('%Y-%m-%d %H:%M')})
    return [table(rows, [], 'Pre-capture libraries', 'q-rnaiso', '2026-10-16T11:52:00')]


def hyb_set(tab, blank_prefix='Pool', make_unique=False, qid='q-hyb'):
    ws = TABS[tab]
    rows, warnings, when = std_rows(ws, blank_prefix, make_unique)
    return table(rows, warnings, 'Post-capture libraries', qid, when)


def dnase_hyb_set():
    ws = TABS['IDT xGen Hyb and Wash v3 - DNas']
    rows = []
    for i in range(3):
        r = 88 + i
        rows.append({'name': f'Pool {i + 1}', 'conc': float(ws.cell(r, 3).value), 'rawConc': f'{ws.cell(r, 3).value:g}', 'unit': 'ng/µL', 'nM': None,
                     'r280': float(ws.cell(r, 4).value), 'r230': float(ws.cell(r, 5).value), 'date': ''})
    return table(rows, ['no sample IDs in the workbook: named "Pool 1" to "Pool 3" from the # column.'], 'Post-capture libraries', 'q-dnase-hyb', '2026-09-11')


def main():
    udi_wells_dnase = [TABS['KAPA RNA HyperPrep - DNase scre'].cell(93 + i, 5).value for i in range(18)]
    batches = [
        kapa_batch('KAPA RNA HyperPrep - batch 1', 'seed-b1-prep', 'Batch 1 · prep', 'kapa_v1', 3, wells_between('D1', 'E12'), qc_builder=std_set('Pre-capture libraries', 'q-b1')),
        xgen_batch('IDT xGen Hyb and Wash v3 - batc', 'seed-b1-hyb', 'Batch 1 · hyb', 'xgen_v1', 'KAPA RNA HyperPrep - batch 1', hyb_set('IDT xGen Hyb and Wash v3 - batc', qid='q-b1h')),
        kapa_batch('KAPA RNA HyperPrep - batch 2', 'seed-b2-prep', 'Batch 2 · prep', 'kapa_v1', 3, wells_between('F1', 'G12'), qc_builder=std_set('Pre-capture libraries', 'q-b2')),
        xgen_batch('Sheet2', 'seed-b2-hyb', 'Batch 2 · hyb', 'xgen_v1', 'KAPA RNA HyperPrep - batch 2', hyb_set('Sheet2', qid='q-b2h')),
        kapa_batch('KAPA RNA HyperPrep - DNase scre', 'seed-dnase-prep', 'DNase · prep', 'kapa_v1', 6, udi_wells_dnase, qc_builder=dnase_prep),
        xgen_batch('IDT xGen Hyb and Wash v3 - DNas', 'seed-dnase-hyb', 'DNase · hyb', 'xgen_v1', 'KAPA RNA HyperPrep - DNase scre', dnase_hyb_set()),
        kapa_batch('KAPA RNA HyperPrep - batch 3', 'seed-b3-prep', 'Batch 3 · prep', 'kapa_v1', 3, qc_builder=std_set('Pre-capture libraries', 'q-b3')),
        xgen_batch('Sheet3', 'seed-b3-hyb', 'Batch 3 · hyb', 'xgen_v1', 'KAPA RNA HyperPrep - batch 3', hyb_set('Sheet3', qid='q-b3h')),
        kapa_batch('KAPA RNA HyperPrep - batch 4', 'seed-b4-prep', 'Batch 4 · prep', 'kapa_v2', 3, qc_builder=b4_sets),
        xgen_batch('xGen Hyb and Wash v3 - batch 4', 'seed-b4-hyb', 'Batch 4 · hyb', 'xgen_v2', 'KAPA RNA HyperPrep - batch 4', hyb_set('xGen Hyb and Wash v3 - batch 4', qid='q-b4h')),
        kapa_batch('KAPA RNA HyperPrep - batch 5', 'seed-b5-prep', 'Batch 5 · prep', 'kapa_v3', 3, cohyb='RNA isolation test (hyb and capture together)', qc_builder=std_set('Pre-capture libraries', 'q-b5')),
        kapa_batch('KAPA RNA HyperPrep - RNA isolat', 'seed-rnaiso-prep', 'RNA iso · prep', 'kapa_v3', 3, cohyb='Batch 5 (hyb and capture together)', qc_builder=rna_iso, pooled=False),
        xgen_batch('xGen Hyb and Wash v3 - batch 5', 'seed-b5-hyb', 'Batch 5 · hyb', 'xgen_v2', 'KAPA RNA HyperPrep - batch 5',
                   hyb_set('xGen Hyb and Wash v3 - batch 5', make_unique=True, qid='q-b5h'), cohyb='8 pools of 3 from batch 5 and 2 pools of 5 from the RNA isolation test'),
        # batch 6: library prep started 2026-11-02 but no step is ticked; its NanoDrop table (and its hyb/capture/sequencing dates)
        # are an exact stale copy of the RNA isolation tab, so no readings are imported.
        kapa_batch('KAPA RNA HyperPrep - batch 6', 'seed-b6-prep', 'Batch 6 · prep', 'kapa_v3', 3),
    ]
    # each library prep and the hyb/capture that processed it (batch 5 and the RNA isolation test were hybridized together)
    pairs = [('seed-b1-prep', 'seed-b1-hyb'), ('seed-b2-prep', 'seed-b2-hyb'), ('seed-dnase-prep', 'seed-dnase-hyb'), ('seed-b3-prep', 'seed-b3-hyb'),
             ('seed-b4-prep', 'seed-b4-hyb'), ('seed-b5-prep', 'seed-b5-hyb'), ('seed-rnaiso-prep', 'seed-b5-hyb')]
    by_id = {b['id']: b for b in batches}
    for b in batches:
        b['role'] = 'hyb' if b['id'].endswith('-hyb') else 'prep'
        b['links'] = []
    for prep, hyb in pairs:
        by_id[prep]['links'].append(hyb)
        by_id[hyb]['links'].append(prep)
    batches.sort(key=lambda b: b['created'])
    seed = {
        'version': 2,
        'plates': {PLATE: {'id': PLATE, 'name': 'UDI plate (from workbook)', 'flags': {w: 'Noticed lower volume of indexing primers (batch 1)' for w in wells_between('D1', 'D8')}}},
        'protocols': PROTOCOLS,
        'batches': batches,
    }
    json.dump(seed, sys.stdout, ensure_ascii=False, separators=(',', ':'))


if __name__ == '__main__':
    main()
