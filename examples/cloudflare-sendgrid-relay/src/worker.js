import { verifySendGridSignature } from './sendgrid-signature.js';

const PATH = '/api/webhooks/sendgrid';
const MAX_BYTES = 2 * 1024 * 1024;
const SIGNATURE = 'x-twilio-email-event-webhook-signature';
const TIMESTAMP = 'x-twilio-email-event-webhook-timestamp';

async function readBody(request) {
  if (Number(request.headers.get('content-length')) > MAX_BYTES) throw new Error('too-large');
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) { await reader.cancel(); throw new Error('too-large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== PATH) return new Response('Not found', { status: 404 });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
    let upstream, receiver;
    try {
      upstream = new URL(env.UPSTREAM_WEBHOOK_URL);
      receiver = new URL(env.RECEIVER_URL);
      if ([upstream, receiver].some(url => url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) || receiver.pathname !== PATH) throw new Error('config');
      if (!env.SITES_GATE_TOKEN || !env.SENDGRID_VERIFICATION_KEY) throw new Error('config');
    } catch { return new Response('Receiver is not configured', { status: 503 }); }
    let body;
    try { body = await readBody(request); }
    catch (error) { return new Response('Invalid payload', { status: error.message === 'too-large' ? 413 : 400 }); }
    const signature = request.headers.get(SIGNATURE);
    const timestamp = request.headers.get(TIMESTAMP);
    if (!await verifySendGridSignature(env.SENDGRID_VERIFICATION_KEY, signature, timestamp, body)) return new Response('Unauthorized webhook', { status: 401 });
    // The caller cannot choose the destination or forward arbitrary headers.
    try {
      const response = await fetch(upstream.href, {
        method: 'POST', body, redirect: 'manual', signal: AbortSignal.timeout(15000),
        headers: {
          'content-type': 'application/json',
          'OAI-Sites-Authorization': `Bearer ${env.SITES_GATE_TOKEN}`,
          [SIGNATURE]: signature,
          [TIMESTAMP]: timestamp,
          'x-marketingcloud-webhook-receiver': receiver.href,
        },
      });
      const ok = response.ok;
      await response.body?.cancel();
      return new Response(ok ? 'Accepted' : 'Webhook processing failed', { status: ok ? 200 : 502 });
    } catch { return new Response('Webhook processing failed', { status: 502 }); }
  },
};
