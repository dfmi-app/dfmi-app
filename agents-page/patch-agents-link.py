#!/usr/bin/env python3
"""patch-agents-link.py — add an "Agents" link (EN/ZH) to the footer link row of dfmi.app pages.

Targets the shared footer:  <div class="flinks"><a href="/privacy.html" data-i18n="t32">Privacy Policy</a>…
Inserts before it:          <a href="/agents/" data-i18n="tAg">Agents</a>
and adds "tAg":"Agents 实况" to the page's ZH dictionary.

Idempotent per file; backs up each file to <name>.bak-<timestamp>; skips a file whose anchors are missing.
Usage: python3 patch-agents-link.py /home/ubuntu/faucet/dfmi/faucet.html [/path/to/legal.html …]
"""
import sys, time, pathlib, re

LINK = '<a href="/agents/" data-i18n="tAg">Agents</a>'
ZH_KEY = '"tAg":"Agents 实况",'

for arg in sys.argv[1:]:
    F = pathlib.Path(arg)
    if not F.exists(): print(f'skip {F}: not found'); continue
    s = F.read_text(encoding='utf-8')
    if 'data-i18n="tAg"' in s: print(f'skip {F}: already patched'); continue
    m = re.search(r'<div class="flinks">', s)
    z = re.search(r'var ZH = \{', s)
    if not m or not z: print(f'skip {F}: anchors not found (flinks={bool(m)}, ZH={bool(z)})'); continue
    s = s[:m.end()] + LINK + s[m.end():]
    z = re.search(r'var ZH = \{', s)
    s = s[:z.end()] + ZH_KEY + s[z.end():]
    bak = F.with_name(F.name + '.bak-' + time.strftime('%Y%m%d-%H%M%S'))
    bak.write_text(F.read_text(encoding='utf-8'), encoding='utf-8')
    F.write_text(s, encoding='utf-8')
    print(f'patched {F} (backup {bak.name})')
