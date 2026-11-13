import { buildPushHTTPRequest } from "npm:@pushforge/builder@2";
import { getConfig, setConfig, sql } from "./db.ts";

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}

// VAPID keys are generated once and kept in private.config.
export async function vapidKeys(): Promise<{ publicKey: string; privateJWK: JsonWebKey }> {
  const stored = await getConfig("vapid_private_jwk");
  if (stored) {
    const jwk = JSON.parse(stored) as JsonWebKey;
    const pub = new Uint8Array([4, ...fromB64url(jwk.x!), ...fromB64url(jwk.y!)]);
    return { publicKey: b64url(pub), privateJWK: jwk };
  }
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const clean: JsonWebKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d };
  await setConfig("vapid_private_jwk", JSON.stringify(clean));
  const pub = new Uint8Array([4, ...fromB64url(clean.x!), ...fromB64url(clean.y!)]);
  return { publicKey: b64url(pub), privateJWK: clean };
}

export type PushMessage = { title: string; body: string; url: string; tag?: string };

// Send to every device the user has subscribed. Returns how many deliveries succeeded.
export async function pushToUser(userId: string, msg: PushMessage): Promise<number> {
  const subs = await sql`select id, endpoint, p256dh, auth from public.push_subscriptions where user_id = ${userId}`;
  if (!subs.length) return 0;
  const { privateJWK } = await vapidKeys();
  let sent = 0;
  for (const s of subs) {
    try {
      const { endpoint, headers, body } = await buildPushHTTPRequest({
        privateJWK,
        subscription: { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        message: {
          payload: msg,
          adminContact: "https://abratica.github.io/ps-health/",
          options: { ttl: 4 * 3600, urgency: "normal", topic: msg.tag?.slice(0, 32).replace(/[^A-Za-z0-9_-]/g, "") || undefined },
        },
      });
      const res = await fetch(endpoint, { method: "POST", headers, body });
      if (res.status === 404 || res.status === 410) {
        await sql`delete from public.push_subscriptions where id = ${s.id}`;
      } else if (res.ok) {
        sent++;
      } else {
        console.error("push failed", res.status, await res.text());
      }
    } catch (e) {
      console.error("push error", e);
    }
  }
  return sent;
}
