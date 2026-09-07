#!/usr/bin/env python3
"""patch-trial-copy.py — rewrite the "trial's 10 dUSD" paragraph (EN + ZH) on dfmi.app pages.

Finds the element whose inner HTML contains the old EN sentence, reads its data-i18n key, replaces the EN text
(keeping the page's own mailto link), and replaces the ZH dictionary value for that same key.
Idempotent; backs up to <name>.bak-<timestamp>.
Usage: python3 patch-trial-copy.py /var/www/html/dfmi.app/index.html [/home/ubuntu/faucet/dfmi/faucet.html]
"""
import sys, time, pathlib, re

OLD_MARK = 'M0 supply'
MAIL = 'admin@dfmi.app'
NEW_EN = ("The trial's 10 dUSD covers a few orders. Building something bigger or longer-running? "
          "Email {mail} with a line about what you're doing and we'll send more. "
          "dUSD is a fixed-supply test unit, so beyond the faucet it is handed out by a person, not a form.")
NEW_ZH = ("试用的 10 dUSD 够跑几笔订单。要做更大或更长期的东西？给 {mail} 发封邮件，说一句你在做什么，我们会补发。"
          "dUSD 是固定供应量的测试单位，水龙头之外由人手工发放，没有申请表。")

for arg in sys.argv[1:]:
    F = pathlib.Path(arg)
    if not F.exists(): print(f'skip {F}: not found'); continue
    s = F.read_text(encoding='utf-8')
    if OLD_MARK not in s: print(f'skip {F}: old text not found (already patched?)'); continue

    # the EN element: <tag ... data-i18n="KEY" ...> … M0 supply … </tag>   (inner HTML may contain <a>)
    m = None
    for cand in re.finditer(r'<(\w+)\b([^>]*data-i18n="([^"]+)"[^>]*)>(.*?)</\1>', s, re.S):
        if OLD_MARK in cand.group(4): m = cand; break
    if not m: print(f'skip {F}: EN element with data-i18n not found'); continue
    tag, attrs, key, inner = m.groups()
    link = re.search(r'<a\b[^>]*>' + re.escape(MAIL) + r'</a>', inner)
    en_mail = link.group(0) if link else MAIL
    s = s[:m.start()] + f'<{tag}{attrs}>{NEW_EN.format(mail=en_mail)}</{tag}>' + s[m.end():]

    # the ZH value for the same key: "KEY":"…"  (use a link only if the old ZH value already had one)
    z = re.search(r'(["\']?' + re.escape(key) + r'["\']?\s*:\s*)(["\'])((?:\\.|(?!\2).)*)\2', s)
    if z:
        q = z.group(2)
        zh_mail = en_mail if '<a' in z.group(3) else MAIL
        new_zh = NEW_ZH.format(mail=zh_mail).replace(q, '\\' + q)
        s = s[:z.start()] + z.group(1) + q + new_zh + q + s[z.end():]
    else:
        print(f'warn {F}: ZH key {key} not found; EN replaced only')

    bak = F.with_name(F.name + '.bak-' + time.strftime('%Y%m%d-%H%M%S'))
    bak.write_text(F.read_text(encoding='utf-8'), encoding='utf-8')
    F.write_text(s, encoding='utf-8')
    print(f'patched {F}: key {key}, EN{" + ZH" if z else ""} (backup {bak.name})')
