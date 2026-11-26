// Cloud drill preload (2026-11-26): wraps the REAL AWS clients. Every real SES SendEmail is logged (one line per
// submission, with its messageId tag) to DRILL_SES_LOG, so "submitted once" is counted at the call, not inferred.
// Faults, read from DRILL_CONTROL before each call:
//   {"ses":"lost-response"}       call SES for real, then throw a timeout (SES accepted, the answer is lost)
//   {"ses":"error-not-sent"}      throw a 500 WITHOUT calling SES (nothing was sent)
//   {"s3":"sent-commit-then-fail"} outbox PutObject whose body has state "sent": write it for real, then throw a 503
//   {"s3":"journal-sent-commit-then-fail"} the same for the journal entry in the events bucket
//   {"ses":"no-events"}            send for real WITHOUT the configuration set: SES publishes no event for it
// Also forces every listening socket onto 127.0.0.1.
const fs = require('node:fs');
const net = require('net'); const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (typeof args[0] === 'number' || typeof args[0] === 'string') { const port = args[0]; const cb = args.find((a) => typeof a === 'function'); return listen.call(this, { port: Number(port), host: '127.0.0.1' }, cb); }
  if (args[0] && typeof args[0] === 'object') { args[0] = { ...args[0], host: '127.0.0.1' }; }
  return listen.apply(this, args);
};
const ctl = () => { try { return JSON.parse(fs.readFileSync(process.env.DRILL_CONTROL, 'utf8')); } catch { return {}; } };
const err = (name, code) => { const e = new Error(name); e.name = name; e.$metadata = { httpStatusCode: code }; return e; };
const ses = require('@aws-sdk/client-sesv2'); const realSes = ses.SESv2Client.prototype.send;
ses.SESv2Client.prototype.send = async function (cmd, ...rest) {
  const f = ctl(); const tag = (cmd.input?.EmailTags || []).find((t) => t.Name === 'messageId')?.Value;
  if (f.ses === 'error-not-sent') throw err('InternalFailure', 500);
  if (f.ses === 'no-events') delete cmd.input.ConfigurationSetName;
  const r = await realSes.call(this, cmd, ...rest);
  fs.appendFileSync(process.env.DRILL_SES_LOG, JSON.stringify({ at: new Date().toISOString(), tag, sesMessageId: r.MessageId, to: cmd.input?.Destination?.ToAddresses }) + '\n');
  if (f.ses === 'lost-response') { const e = new Error('drill: response lost after SES accepted'); e.name = 'TimeoutError'; throw e; }
  return r;
};
const s3 = require('@aws-sdk/client-s3'); const realS3 = s3.S3Client.prototype.send;
s3.S3Client.prototype.send = async function (cmd, ...rest) {
  const f = ctl();
  const pre = f.s3 === 'sent-commit-then-fail' ? 'outbox/' : f.s3 === 'journal-sent-commit-then-fail' ? 'journal/' : null;
  const hit = pre && cmd.constructor.name === 'PutObjectCommand' && String(cmd.input?.Key || '').startsWith(pre) && (() => { try { return JSON.parse(String(cmd.input.Body)).state === 'sent'; } catch { return false; } })();
  const r = await realS3.call(this, cmd, ...rest);
  if (hit) throw err('ServiceUnavailable', 503);
  return r;
};
