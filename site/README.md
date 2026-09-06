# site

The static pages of dfmi.app, kept here so every change goes through the repo: `faucet.html` (the home page, served by the faucet process), `legal.html`, `privacy.html`, `terms.html`.

Edit here, push, then on the server:

```bash
cd /home/ubuntu/dfmi-app && git pull && bash site/deploy.sh
```

`deploy.sh` copies only files that changed and keeps a timestamped backup of what it replaced. The pages are plain HTML with an EN/ZH dictionary (`const ZH = {…}` and `data-i18n` attributes); nothing in them is secret.
