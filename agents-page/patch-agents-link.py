#!/usr/bin/env python3
"""patch-agents-link.py — link /agents/ from the other dfmi.app pages (EN + ZH), consistently.

What it adds, per file, only where the anchor exists:
  - header nav:  a copy of the nav item marked data-i18n="nav3", pointing to /agents/, labelled "Agents"   (home page)
  - footer:      <a href="/agents/" data-i18n="tAg">Agents</a> as the first link inside <div class="flinks">  (all pages)
  - ZH dict:     "tAg":"Agents 实况" (and "navAg":"Agents 实况" when a nav item was added), into `const|var|let ZH = {`

Idempotent per file (skips if data-i18n="tAg" is already there); backs up to <name>.bak-<timestamp>; never writes a file whose anchors are missing.
Usage: python3 patch-agents-link.py /home/ubuntu/faucet/dfmi/faucet.html [legal.html privacy.html terms.html …]
"""
import sys, time, pathlib, re

for arg in sys.argv[1:]:
    F = pathlib.Path(arg)
    if not F.exists(): print(f'skip {F}: not found'); continue
    s = F.read_text(encoding='utf-8')
    if 'data-i18n="tAg"' in s: print(f'skip {F}: already patched'); continue

    zh = re.search(r'(const|var|let)\s+ZH\s*=\s*\{', s)
    fl = re.search(r'<div class="flinks">\s*', s)
    if not zh or not fl: print(f'skip {F}: anchors not found (ZH={bool(zh)}, flinks={bool(fl)})'); continue

    keys = '"tAg":"Agents 实况",'
    # header nav item (home page): clone the nav3 anchor
    nav = re.search(r'<a\b[^>]*data-i18n="nav3"[^>]*>.*?</a>', s, re.S)
    if nav:
        item = nav.group(0)
        item = re.sub(r'href="[^"]*"', 'href="/agents/"', item, count=1)
        item = item.replace('data-i18n="nav3"', 'data-i18n="navAg"')
        item = re.sub(r'>[^<]*</a>$', '>Agents</a>', item)
        s = s[:nav.end()] + item + s[nav.end():]
        keys += '"navAg":"Agents 实况",'
        fl = re.search(r'<div class="flinks">\s*', s); zh = re.search(r'(const|var|let)\s+ZH\s*=\s*\{', s)

    # footer link, first in the row, matching the row's own indentation
    indent = re.search(r'\n([ \t]*)<a\b', s[fl.end():fl.end() + 200])
    pad = indent.group(1) if indent else ''
    s = s[:fl.end()] + f'<a href="/agents/" data-i18n="tAg">Agents</a>\n{pad}' + s[fl.end():]
    zh = re.search(r'(const|var|let)\s+ZH\s*=\s*\{', s)
    s = s[:zh.end()] + '\n    ' + keys + s[zh.end():]

    bak = F.with_name(F.name + '.bak-' + time.strftime('%Y%m%d-%H%M%S'))
    bak.write_text(F.read_text(encoding='utf-8'), encoding='utf-8')
    F.write_text(s, encoding='utf-8')
    print(f'patched {F}: footer link{" + nav item" if nav else ""} (backup {bak.name})')
