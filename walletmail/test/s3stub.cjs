// preload: replace AWS S3/SES network calls with a JSON-file object store (shared across restarts)
const fs = require('fs'); const F = process.env.S3_STUB_FILE;
const load = () => { try { return JSON.parse(fs.readFileSync(F, 'utf8')); } catch { return {}; } };
const save = (o) => fs.writeFileSync(F, JSON.stringify(o));
const { Readable } = require('stream');
const s3 = require('@aws-sdk/client-s3');
s3.S3Client.prototype.send = async function (cmd) {
  if (process.env.S3_STUB_FAIL === '1') { const e = new Error('stub outage'); e.name = 'ServiceUnavailable'; throw e; }
  const k = cmd.input.Key, n = cmd.constructor.name, o = load();
  if (n === 'PutObjectCommand') { o[k] = String(cmd.input.Body); save(o); return {}; }
  if (n === 'GetObjectCommand') { if (!(k in o)) { const e = new Error('nk'); e.name = 'NoSuchKey'; throw e; } return { Body: Readable.from([Buffer.from(o[k])]) }; }
  if (n === 'DeleteObjectCommand') { delete o[k]; save(o); return {}; }
  if (n === 'ListObjectsV2Command') return { Contents: [] };
  return {};
};
const ses = require('@aws-sdk/client-sesv2'); ses.SESv2Client.prototype.send = async () => ({});
