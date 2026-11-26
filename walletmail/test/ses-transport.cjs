// Keep the real SES SDK middleware; replace only its HTTP transport. No AWS calls.
const fs = require('node:fs');
const { SESv2Client } = require('@aws-sdk/client-sesv2');
const realSend = SESv2Client.prototype.send;
require('./outbox-store.cjs'); // local S3 fixture; its SES send stub is undone below
SESv2Client.prototype.send = realSend;
const { NodeHttpHandler } = require('@smithy/node-http-handler');
NodeHttpHandler.prototype.handle = async function (request) {
  if (request.method !== 'POST' || request.path !== '/v2/email/outbound-emails') throw Error('Unexpected transport request');
  const input = JSON.parse(Buffer.from(request.body).toString());
  const tag = input.EmailTags?.find(t => t.Name === 'messageId')?.Value;
  fs.appendFileSync(process.env.DRILL_AUDIT + '.transport', JSON.stringify({ tag }) + '\n');
  const fault = JSON.parse(fs.readFileSync(process.env.DRILL_CONTROL, 'utf8'));
  if (fault.ses === 'error-not-sent') return { response: { statusCode: 500, headers: { 'content-type': 'application/json', 'x-amzn-errortype': 'InternalFailure' }, body: Buffer.from('{"message":"offline injected 500"}') } };
  const id = 'offline-' + require('node:crypto').randomUUID();
  fs.appendFileSync(process.env.DRILL_AUDIT, JSON.stringify({ tag, id }) + '\n');
  if (fault.ses === 'lost-response') { const e = new Error('offline: response lost after simulated acceptance'); e.name = 'TimeoutError'; throw e; }
  return { response: { statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ MessageId: id })) } };
};
