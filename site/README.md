# site

The static dfmi.app site, kept here so every change goes through the repo.

- `www/` is `/var/www/html/dfmi.app/` on the server: `index.html` (home), `legal.html`, `privacy.html`, `terms.html`, `wallet.html`, the layer pages (`control-plane.html`, `identity-layer.html`, `intent-layer.html`, `two-fates.html`) and the `og-*.png` images. Served by nginx.
- `faucet.html` is `/home/ubuntu/faucet/dfmi/faucet.html`, served by the faucet process at faucet.dfmi.app.

Edit here, push, then on the server:

```bash
cd /home/ubuntu/dfmi-app && git pull && bash site/deploy.sh
```

`deploy.sh` copies only files that changed, keeps a timestamped backup of each file it replaces, and never deletes anything. The pages are plain HTML with an EN/ZH dictionary (`const ZH = {…}` and `data-i18n` attributes); nothing in them is secret.
