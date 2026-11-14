"""Write private ui-demos/server-data/wrapped-data.json: recaps for demo customers and personas.

Usage (repo root):  python -m wrapped.export_ui [CUST... more ids]
Needs wrapped/output/facts.json (python wrapped/build_facts.py).
"""
import json
import sys

from .cards import REPO, build_recap, load_sources

UI_DATA = REPO / 'ui-demos' / 'server-data' / 'demo-data.json'
PERSONAS = REPO / 'demo' / 'personas.json'
OUT = REPO / 'ui-demos' / 'server-data' / 'wrapped-data.json'


def default_ids():
    ui = json.loads(UI_DATA.read_text(encoding='utf-8'))
    personas = json.loads(PERSONAS.read_text(encoding='utf-8'))['personas']
    ids = [p['customer_id'] for p in ui['profiles']] + [p['customer_id'] for p in personas]
    return list(dict.fromkeys(ids))


def main(argv=None):
    extra = (argv if argv is not None else sys.argv[1:])
    src = load_sources()
    ids = list(dict.fromkeys(default_ids() + extra))
    data = {'period': src['period'], 'recaps': {cid: build_recap(cid, src)['cards'] for cid in ids}}
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{len(ids)} recaps -> {OUT} ({OUT.stat().st_size / 1000:.0f} kB)')


if __name__ == '__main__':
    main()
