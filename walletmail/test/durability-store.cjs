const fs = require('node:fs');
const { Readable } = require('node:stream');
const file = process.env.DRILL_STORE;
const control = process.env.DRILL_CONTROL;
const audit = process.env.DRILL_AUDIT;
const load = () => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = (o) => fs.writeFileSync(file, JSON.stringify(o));
const s3 = require('@aws-sdk/client-s3');
s3.S3Client.prototype.send = async function (cmd) {
  const name = cmd.constructor.name, i = cmd.input;
  const fault = JSON.parse(fs.readFileSync(control, 'utf8'));
  fs.appendFileSync(audit, JSON.stringify({ name, key: i.Key, prefix: i.Prefix, continuation: i.ContinuationToken }) + '\n');
  if (fault.name === name && (i.Key || i.Prefix || '').startsWith(fault.prefix || '') && (!fault.continuationOnly || i.ContinuationToken)) {
    const e = new Error('independent drill injected storage failure'); e.name = 'ServiceUnavailable'; throw e;
  }
  const o = load(); const k = i.Bucket + '/' + i.Key;
  if (name === 'PutObjectCommand') {
    o[k] = { body: Buffer.from(i.Body).toString('base64'), modified: new Date().toISOString(), type: i.ContentType };
    save(o); return {};
  }
  if (name === 'GetObjectCommand') {
    if (!o[k]) { const e = new Error('not found'); e.name = 'NoSuchKey'; throw e; }
    return { Body: Readable.from([Buffer.from(o[k].body, 'base64')]) };
  }
  if (name === 'DeleteObjectCommand') { delete o[k]; save(o); return {}; }
  if (name === 'ListObjectsV2Command') {
    const pre = i.Bucket + '/';
    const keys = Object.keys(o).filter(k => k.startsWith(pre + (i.Prefix || ''))).sort();
    const start = Number(i.ContinuationToken || 0), max = Math.min(i.MaxKeys || 1000, 1000);
    const selected = keys.slice(start, start + max), truncated = start + max < keys.length;
    const next = fault.cursorMode === 'repeat' ? '0' : String(start + max);
    return { Contents: selected.map(k => ({ Key: k.slice(pre.length), LastModified: new Date(o[k].modified), Size: Buffer.from(o[k].body, 'base64').length })),
      IsTruncated: truncated, ...(truncated && fault.cursorMode !== 'missing' ? { NextContinuationToken: next } : {}) };
  }
  throw new Error('unimplemented isolated storage command ' + name);
};
const ses = require('@aws-sdk/client-sesv2');
ses.SESv2Client.prototype.send = async function () {
  fs.appendFileSync(audit, JSON.stringify({ name: 'SES_SEND_SIMULATED' }) + '\n'); return { MessageId: 'local-only' };
};
