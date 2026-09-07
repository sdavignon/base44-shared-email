const encoder = new TextEncoder();

export function normalizedPublicKey(value) {
  return (value || '').replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, '');
}

function decode(value) {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}

export async function isSendGridPublicKey(value) {
  try {
    await crypto.subtle.importKey('spki', decode(normalizedPublicKey(value)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return true;
  } catch { return false; }
}

// SendGrid uses ASN.1 DER signatures; Web Crypto expects the two 32-byte integers.
function derToRaw(bytes) {
  if (bytes[0] !== 0x30 || bytes[1] !== bytes.length - 2) throw new Error('Invalid signature');
  const raw = new Uint8Array(64);
  let offset = 2;
  for (let part = 0; part < 2; part++) {
    if (bytes[offset++] !== 2) throw new Error('Invalid integer');
    const length = bytes[offset++];
    let integer = bytes.slice(offset, offset + length);
    if (!length || integer.length !== length || (integer[0] & 0x80)) throw new Error('Invalid integer');
    offset += length;
    if (integer[0] === 0 && integer.length > 1) integer = integer.slice(1);
    if (integer.length > 32) throw new Error('Invalid integer');
    raw.set(integer, part * 32 + 32 - integer.length);
  }
  if (offset !== bytes.length) throw new Error('Trailing data');
  return raw;
}

export async function verifySendGridSignature(publicKey, signature, timestamp, body, now = Date.now()) {
  if (!signature || !/^\d{10}$/.test(timestamp || '')) return false;
  // Allow SendGrid's 24-hour delivery retries, but reject stale/future requests.
  const age = now / 1000 - Number(timestamp);
  if (age < -300 || age > 25 * 3600) return false;
  try {
    const key = await crypto.subtle.importKey('spki', decode(normalizedPublicKey(publicKey)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(decode(signature)), encoder.encode(timestamp + body));
  } catch { return false; }
}
