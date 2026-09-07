import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import relay from '../examples/cloudflare-sendgrid-relay/src/worker.js';
import { verifySendGridSignature } from '../examples/cloudflare-sendgrid-relay/src/sendgrid-signature.js';

const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const key = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const env = {
  UPSTREAM_WEBHOOK_URL: 'https://private-site.example.com/api/webhooks/sendgrid',
  RECEIVER_URL: 'https://receiver.example.com/api/webhooks/sendgrid',
  SENDGRID_VERIFICATION_KEY: key,
  SITES_GATE_TOKEN: 'test-only',
};
const body = '[{"event":"bounce","email":"person@example.com","reason":"café"}]\n';
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = sign('sha256', Buffer.from(timestamp + body), pair.privateKey).toString('base64');
const headers = {
  'x-twilio-email-event-webhook-signature': signature,
  'x-twilio-email-event-webhook-timestamp': timestamp,
};
const signedRequest = () => new Request(env.RECEIVER_URL, { method: 'POST', body, headers });
async function mockFetch(mock, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { await fn(); } finally { globalThis.fetch = original; }
}

test('relay verifies exact UTF-8 bodies, rejects tampering, wrong keys, and stale signatures', async () => {
  assert.equal(await verifySendGridSignature(key, signature, timestamp, body), true);
  assert.equal(await verifySendGridSignature(key, signature, timestamp, body.trim()), false);
  assert.equal(await verifySendGridSignature('wrong', signature, timestamp, body), false);
  assert.equal(await verifySendGridSignature(key, signature, timestamp, body, Date.now() + 26 * 3600_000), false);
  assert.equal(await verifySendGridSignature(key, signature, timestamp, body, Date.now() - 3600_000), false);
  assert.equal(await verifySendGridSignature(key, 'malformed', timestamp, body), false);
});

test('relay forwards signed bytes only to configured endpoint without caller cookies or credentials', async () => {
  let forwarded = 0;
  await mockFetch(async (url, options) => {
    forwarded++;
    assert.equal(url, env.UPSTREAM_WEBHOOK_URL);
    assert.equal(options.body, body);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers['OAI-Sites-Authorization'], 'Bearer test-only');
    assert.equal(options.headers['x-marketingcloud-webhook-receiver'], env.RECEIVER_URL);
    assert.equal(options.headers.cookie, undefined);
    assert.equal(options.headers.authorization, undefined);
    return new Response('PRIVATE upstream detail');
  }, async () => {
    const request = new Request(env.RECEIVER_URL + '?url=https://attacker.example.com', {
      method: 'POST', body, headers: { ...headers, Cookie: 'browser-private', Authorization: 'caller-private' },
    });
    const response = await relay.fetch(request, env);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'Accepted');
  });
  assert.equal(forwarded, 1);
});

test('relay fails closed for unsigned requests, other paths, methods, and missing configuration', async () => {
  await mockFetch(() => { throw new Error('Must not forward'); }, async () => {
    assert.equal((await relay.fetch(new Request(env.RECEIVER_URL, { method: 'POST', body }), env)).status, 401);
    assert.equal((await relay.fetch(new Request('https://receiver.example.com/api/contacts'), env)).status, 404);
    assert.equal((await relay.fetch(new Request(env.RECEIVER_URL), env)).status, 405);
    assert.equal((await relay.fetch(signedRequest(), { ...env, SITES_GATE_TOKEN: '' })).status, 503);
    assert.equal((await relay.fetch(signedRequest(), { ...env, UPSTREAM_WEBHOOK_URL: 'http://private-site.example.com' })).status, 503);
    assert.equal((await relay.fetch(signedRequest(), { ...env, UPSTREAM_WEBHOOK_URL: 'https://private-site.example.com/?token=example' })).status, 503);
  });
});

test('relay limits streamed and declared payload size before forwarding', async () => {
  await mockFetch(() => { throw new Error('Must not forward'); }, async () => {
    const declared = new Request(env.RECEIVER_URL, { method: 'POST', body: '[]', headers: { 'content-length': '3000000' } });
    assert.equal((await relay.fetch(declared, env)).status, 413);
    const streamed = new Request(env.RECEIVER_URL, { method: 'POST', body: 'x'.repeat(2 * 1024 * 1024 + 1) });
    assert.equal((await relay.fetch(streamed, env)).status, 413);
  });
});

test('relay propagates upstream failures and redirects as retryable generic failures', async () => {
  for (const status of [302, 401, 500]) {
    await mockFetch(async () => new Response('private failure details', { status }), async () => {
      const response = await relay.fetch(signedRequest(), env);
      assert.equal(response.status, 502);
      assert.equal(await response.text(), 'Webhook processing failed');
    });
  }
  await mockFetch(async () => { throw new Error('network details'); }, async () => {
    assert.equal((await relay.fetch(signedRequest(), env)).status, 502);
  });
});
