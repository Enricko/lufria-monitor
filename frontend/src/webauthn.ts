// Passkeys: the server sends WebAuthn options as JSON (binary fields in base64url) and expects the
// credential back the same way. Converted by hand: parse*FromJSON / toJSON aren't in every Safari yet.

type Json = Record<string, any>;

const dec = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

function enc(buf: ArrayBuffer | null): string | null {
  if (!buf) return null;
  let bin = "";
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const descriptors = (list?: Json[]): PublicKeyCredentialDescriptor[] =>
  (list ?? []).map((c) => ({ ...c, type: "public-key", id: dec(c.id) }));

/** Passkeys need a secure context: https, or localhost. */
export const passkeysSupported = () => !!window.PublicKeyCredential && window.isSecureContext;

export async function createPasskey(o: Json): Promise<Json> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      ...(o as PublicKeyCredentialCreationOptions),
      challenge: dec(o.challenge),
      user: { ...o.user, id: dec(o.user.id) },
      excludeCredentials: descriptors(o.excludeCredentials),
    },
  })) as PublicKeyCredential;
  const r = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    rawId: enc(cred.rawId),
    type: cred.type,
    response: { clientDataJSON: enc(r.clientDataJSON), attestationObject: enc(r.attestationObject), transports: r.getTransports?.() ?? [] },
    authenticatorAttachment: cred.authenticatorAttachment,
    clientExtensionResults: cred.getClientExtensionResults(),
  };
}

export async function getPasskey(o: Json): Promise<Json> {
  const cred = (await navigator.credentials.get({
    publicKey: { ...(o as PublicKeyCredentialRequestOptions), challenge: dec(o.challenge), allowCredentials: descriptors(o.allowCredentials) },
  })) as PublicKeyCredential;
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: enc(cred.rawId),
    type: cred.type,
    response: { clientDataJSON: enc(r.clientDataJSON), authenticatorData: enc(r.authenticatorData), signature: enc(r.signature), userHandle: enc(r.userHandle) },
    authenticatorAttachment: cred.authenticatorAttachment,
    clientExtensionResults: cred.getClientExtensionResults(),
  };
}

/** Short message for a failed passkey prompt. Cancelling (or timing out) is a NotAllowedError. */
export function passkeyError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError") return "Cancelled, or no passkey for this site on this device.";
    if (err.name === "InvalidStateError") return "This device already has a passkey here.";
  }
  const s = String(err);
  if (s.includes("429")) return "Too many attempts. Try again in 5 minutes.";
  return "That didn't work. Try again.";
}

/** A name for a new passkey, from the device it's made on. */
export function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "Passkey";
}
