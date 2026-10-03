/**
 * Web Push für die tägliche Erinnerung (RFC 8291 Verschlüsselung, RFC 8292 VAPID).
 *
 * Der VAPID-Schlüssel entsteht beim ersten Mal auf dem Server und bleibt im Durable Object.
 * Er steht nie im Repo und nie im Chat.
 */

const enc = new TextEncoder();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64url(s: string): Uint8Array {
  const t = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

export interface VapidKeys {
  /** öffentlicher Schlüssel, roh (65 Byte), base64url */
  publicKey: string;
  /** privater Schlüssel als JWK */
  privateJwk: JsonWebKey;
}

export async function makeVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer;
  const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  return { publicKey: b64url(raw), privateJwk };
}

/** Authorization-Header: signiertes JWT für den Push-Dienst des Geräts */
async function vapidHeader(endpoint: string, keys: VapidKeys, contact: string): Promise<string> {
  const head = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: contact })));
  const key = await crypto.subtle.importKey('jwk', keys.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`));
  return `vapid t=${head}.${claims}.${b64url(sig)}, k=${keys.publicKey}`;
}

/** Verschlüsselt die Nachricht für genau dieses Gerät (aes128gcm, ein Datensatz) */
export async function encryptPayload(payload: Uint8Array, p256dh: string, auth: string): Promise<Uint8Array> {
  const uaPublic = unb64url(p256dh);
  const authSecret = unb64url(auth);
  const local = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', local.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, local.privateKey, 256));
  // IKM = HKDF(auth, ecdh, "WebPush: info\0" || ua_public || as_public)
  const prkKey = await hmac(authSecret, ecdh);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(payload, new Uint8Array([2]))));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
  contact: string;
}

/** Schickt eine Nachricht. Gibt den HTTP-Status zurück (201 = angenommen, 404/410 = Gerät abgemeldet). */
export async function sendPush(target: PushTarget, message: unknown, keys: VapidKeys, ttl = 4 * 3600): Promise<number> {
  const body = await encryptPayload(enc.encode(JSON.stringify(message)), target.p256dh, target.auth);
  const res = await fetch(target.endpoint, {
    method: 'POST',
    headers: {
      authorization: await vapidHeader(target.endpoint, keys, target.contact),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(ttl),
      urgency: 'normal',
    },
    body,
  });
  if (!res.ok) console.warn('push', res.status, (await res.text().catch(() => '')).slice(0, 200));
  return res.status;
}

// Nur die Push-Dienste der Geräte (Apple, Google, Mozilla, Microsoft), keine beliebigen Adressen
const PUSH_HOST = /(?:^|\.)(?:push\.apple\.com|fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/;

export function pushEndpointOk(endpoint: string, testOrigin?: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (testOrigin && u.origin === testOrigin) return true;
  return u.protocol === 'https:' && !u.port && PUSH_HOST.test(u.hostname) && endpoint.length <= 1000;
}
