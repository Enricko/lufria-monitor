"""Sign-in with passkeys (Touch ID / Face ID) or a QR code approved by a passkey, and a signed session cookie.

Everything lives in data/auth.json (mode 600). The password only bootstraps: once a passkey exists,
password sign-in is refused. Set the password with:
    .venv/bin/python -m app.auth set            # prompts
    ... | .venv/bin/python -m app.auth set --stdin
Add a passkey without being signed in (new device, or every device lost):
    .venv/bin/python -m app.auth enroll         # prints a one-time link + QR, valid 15 minutes
"""
import hashlib
import hmac
import json
import os
import pwd
import secrets
import sys
import time
from http.cookies import SimpleCookie
from urllib.parse import urlsplit

import segno
from webauthn import (base64url_to_bytes, generate_authentication_options, generate_registration_options,
                      options_to_json, verify_authentication_response, verify_registration_response)
from webauthn.helpers import bytes_to_base64url
from webauthn.helpers.structs import (AuthenticatorSelectionCriteria, PublicKeyCredentialDescriptor,
                                      ResidentKeyRequirement, UserVerificationRequirement)

from .config import DATA_DIR, PUBLIC_ORIGIN

AUTH_FILE = DATA_DIR / "auth.json"
COOKIE = "lufria_monitor_session"
SESSION_TTL = 30 * 86400
ITERATIONS = 600_000
# Paths reachable without a session: the SPA shell/assets (no data in them) and the login API
PUBLIC_PREFIXES = ("/assets/", "/api/auth/")
PUBLIC_EXACT = {"/", "/index.html", "/favicon.svg"}

MAX_FAILS = 5
LOCKOUT = 300  # seconds
_fails: dict[str, list[float]] = {}

RP_ID = urlsplit(PUBLIC_ORIGIN).hostname
RP_NAME = "Lufria Monitor"
CHALLENGE_TTL = 120
QR_TTL = 120
ENROLL_TTL = 900
# In-memory, single process. Capped so unauthenticated callers can't grow them forever (oldest go first).
_challenges: dict[str, tuple[str, bytes, float]] = {}  # flow -> (purpose, challenge, expires)
_qr: dict[str, dict] = {}  # request id (in the QR) -> pending sign-in
MAX_CHALLENGES = 2000
MAX_QR = 200


def _load() -> dict | None:
    try:
        return json.loads(AUTH_FILE.read_text())
    except (OSError, ValueError):
        return None


def _save(data: dict) -> None:
    # Write-then-rename, so the server never reads a half-written file while the CLI writes it
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = AUTH_FILE.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f)
    os.replace(tmp, AUTH_FILE)


def _hash(password: str, salt: bytes) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt, ITERATIONS).hex()


def set_password(password: str) -> None:
    salt = secrets.token_bytes(16)
    data = _load() or {}
    data.update(salt=salt.hex(), hash=_hash(password, salt), secret=secrets.token_hex(32))
    _save(data)


def enabled() -> bool:
    return _load() is not None


def has_passkeys() -> bool:
    return bool((_load() or {}).get("passkeys"))


def password_enabled() -> bool:
    data = _load()
    return bool(data and data.get("hash") and not data.get("passkeys"))


def verify_password(password: str) -> bool:
    data = _load()
    if not data or not data.get("hash") or data.get("passkeys"):
        return False
    return hmac.compare_digest(_hash(password, bytes.fromhex(data["salt"])), data["hash"])


def _sign(secret: str, payload: str) -> str:
    return hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()


def make_session() -> str:
    expires = str(int(time.time()) + SESSION_TTL)
    return f"{expires}.{_sign(_load()['secret'], expires)}"


def valid_session(token: str | None) -> bool:
    data = _load()
    if data is None:
        return True  # no password configured -> open
    if not token or "." not in token:
        return False
    expires, sig = token.split(".", 1)
    return (expires.isdigit() and int(expires) > time.time()
            and hmac.compare_digest(sig, _sign(data["secret"], expires)))


def locked_out(ip: str) -> bool:
    now = time.time()
    recent = [t for t in _fails.get(ip, []) if now - t < LOCKOUT]
    _fails[ip] = recent
    return len(recent) >= MAX_FAILS


def record_fail(ip: str) -> None:
    _fails.setdefault(ip, []).append(time.time())


def client_ip(headers: dict[str, str], fallback: str) -> str:
    return headers.get("cf-connecting-ip") or headers.get("x-forwarded-for", "").split(",")[0].strip() or fallback


def same_origin(headers) -> bool:
    """False when a browser sends this from another site. Sibling subdomains count as same-site, so
    SameSite=Lax still sends them our cookie: check Origin before anything that runs commands."""
    origin = headers.get("origin")
    return origin is None or urlsplit(origin).netloc == headers.get("host", "")


# --- passkeys (WebAuthn) ---

def _new_flow(purpose: str) -> tuple[str, bytes]:
    now = time.time()
    for k in [k for k, v in _challenges.items() if v[2] < now]:
        del _challenges[k]
    while len(_challenges) >= MAX_CHALLENGES:
        del _challenges[next(iter(_challenges))]
    flow, challenge = secrets.token_urlsafe(16), secrets.token_bytes(32)
    _challenges[flow] = (purpose, challenge, now + CHALLENGE_TTL)
    return flow, challenge


def _take_challenge(flow, purpose: str) -> bytes | None:
    """Single use: a challenge is gone after one try, right or wrong."""
    c = _challenges.pop(str(flow), None)
    return c[1] if c and c[0] == purpose and c[2] > time.time() else None


def registration_options(purpose: str) -> dict:
    data = _load() or {}
    if "user_id" not in data:  # the passkey's user handle; fixed for this dashboard's single account
        data["user_id"] = secrets.token_hex(16)
        data.setdefault("secret", secrets.token_hex(32))
        _save(data)
    flow, challenge = _new_flow(purpose)
    opts = generate_registration_options(
        rp_id=RP_ID, rp_name=RP_NAME, user_name=pwd.getpwuid(os.getuid()).pw_name,
        user_id=bytes.fromhex(data["user_id"]), challenge=challenge, timeout=CHALLENGE_TTL * 1000,
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.REQUIRED, user_verification=UserVerificationRequirement.REQUIRED),
        exclude_credentials=[PublicKeyCredentialDescriptor(id=base64url_to_bytes(p["id"]))
                             for p in data.get("passkeys", [])])
    return {"flow": flow, "options": json.loads(options_to_json(opts))}


def add_passkey(flow, credential, name: str, purpose: str) -> bool:
    """Verify a new passkey and store it. The first one turns password sign-in off and ends every
    existing session (new secret); the caller hands the browser that added it a fresh cookie."""
    challenge = _take_challenge(flow, purpose)
    if challenge is None:
        return False
    try:
        v = verify_registration_response(credential=credential, expected_challenge=challenge, expected_rp_id=RP_ID,
                                         expected_origin=PUBLIC_ORIGIN, require_user_verification=True)
    except Exception:
        return False
    data = _load() or {}
    if not data.get("passkeys"):
        data["secret"] = secrets.token_hex(32)
    data.setdefault("passkeys", []).append({
        "id": bytes_to_base64url(v.credential_id), "key": bytes_to_base64url(v.credential_public_key),
        "count": v.sign_count, "name": name.strip()[:40] or "Passkey", "synced": v.credential_backed_up,
        "created": int(time.time()), "last_used": None,
    })
    _save(data)
    return True


def list_passkeys() -> list[dict]:
    return [{k: p[k] for k in ("id", "name", "synced", "created", "last_used")}
            for p in (_load() or {}).get("passkeys", [])]


def remove_passkey(cred_id: str) -> str | None:
    """Returns an error message, or None when removed."""
    data = _load() or {}
    keys = data.get("passkeys", [])
    if not any(p["id"] == cred_id for p in keys):
        return "No such passkey"
    if len(keys) == 1:
        return "Add another passkey before removing the last one"
    data["passkeys"] = [p for p in keys if p["id"] != cred_id]
    _save(data)
    return None


def authentication_options(purpose: str) -> dict:
    # No allowCredentials: the browser offers whichever passkey it has for this site (discoverable)
    flow, challenge = _new_flow(purpose)
    opts = generate_authentication_options(rp_id=RP_ID, challenge=challenge, timeout=CHALLENGE_TTL * 1000,
                                           user_verification=UserVerificationRequirement.REQUIRED)
    return {"flow": flow, "options": json.loads(options_to_json(opts))}


def verify_passkey(flow, credential, purpose: str) -> bool:
    challenge = _take_challenge(flow, purpose)
    data = _load()
    if challenge is None or not data or not isinstance(credential, dict):
        return False
    key = next((p for p in data.get("passkeys", []) if p["id"] == credential.get("rawId")), None)
    if key is None:
        return False
    try:
        v = verify_authentication_response(
            credential=credential, expected_challenge=challenge, expected_rp_id=RP_ID, expected_origin=PUBLIC_ORIGIN,
            credential_public_key=base64url_to_bytes(key["key"]), credential_current_sign_count=key["count"],
            require_user_verification=True)
    except Exception:
        return False
    key["count"], key["last_used"] = v.new_sign_count, int(time.time())
    _save(data)
    return True


# --- QR sign-in: this screen shows a code, a phone with the passkey approves it ---

def _device(ua: str) -> str:
    browser = next((b for k, b in (("Edg/", "Edge"), ("OPR/", "Opera"), ("Firefox/", "Firefox"), ("FxiOS/", "Firefox"),
                                   ("CriOS/", "Chrome"), ("Chrome/", "Chrome"), ("Safari/", "Safari")) if k in ua), "A browser")
    system = next((o for k, o in (("iPhone", "iPhone"), ("iPad", "iPad"), ("Android", "Android"), ("Windows", "Windows"),
                                  ("CrOS", "ChromeOS"), ("Mac OS X", "macOS"), ("Linux", "Linux")) if k in ua), None)
    return f"{browser} on {system}" if system else browser


def qr_start(ip: str, ua: str, country: str | None) -> dict:
    now = time.time()
    for k in [k for k, v in _qr.items() if v["expires"] < now]:
        del _qr[k]
    while len(_qr) >= MAX_QR:
        del _qr[next(iter(_qr))]
    rid, poll = secrets.token_urlsafe(16), secrets.token_urlsafe(24)
    _qr[rid] = {"poll": poll, "code": f"{secrets.randbelow(100):02d}", "ip": ip, "device": _device(ua),
                "country": country, "created": now, "expires": now + QR_TTL, "status": "pending"}
    url = f"{PUBLIC_ORIGIN}/approve/{rid}"
    qr = segno.make(url, error="m").svg_data_uri(scale=4, border=4, dark="#000", light="#fff")
    return {"id": rid, "poll": poll, "code": _qr[rid]["code"], "url": url, "qr": qr, "expires_in": QR_TTL}


def _qr_get(rid: str) -> dict | None:
    r = _qr.get(rid)
    return r if r and r["expires"] > time.time() else None


def qr_poll(rid: str, poll) -> str:
    """pending / approved / denied / expired. 'approved' is returned once: the request is used up."""
    r = _qr_get(rid)
    if r is None or not hmac.compare_digest(str(poll), r["poll"]):
        return "expired"
    if r["status"] == "approved":
        del _qr[rid]
    return r["status"]


def qr_info(rid: str) -> dict | None:
    r = _qr_get(rid)
    if r is None or r["status"] != "pending":
        return None
    return {k: r[k] for k in ("code", "ip", "device", "country", "created", "expires")}


def qr_approve(rid: str, flow, credential) -> bool:
    r = _qr_get(rid)
    if r is None or r["status"] != "pending" or not verify_passkey(flow, credential, f"qr:{rid}"):
        return False
    r["status"] = "approved"
    return True


def qr_deny(rid: str) -> None:
    r = _qr_get(rid)
    if r and r["status"] == "pending":
        r["status"] = "denied"


# --- one-time enrolment link from the CLI ---

def new_enroll_link() -> str:
    token = secrets.token_urlsafe(24)
    data = _load() or {}
    data.setdefault("secret", secrets.token_hex(32))
    data["enroll"] = {"hash": hashlib.sha256(token.encode()).hexdigest(), "expires": int(time.time()) + ENROLL_TTL}
    _save(data)
    return f"{PUBLIC_ORIGIN}/enroll/{token}"


def enroll_ok(token) -> bool:
    e = (_load() or {}).get("enroll")
    return bool(e and e["expires"] > time.time()
                and hmac.compare_digest(hashlib.sha256(str(token).encode()).hexdigest(), e["hash"]))


def enroll_done() -> None:
    data = _load() or {}
    data.pop("enroll", None)
    _save(data)


def _cookie_from_scope(scope) -> str | None:
    for k, v in scope.get("headers", []):
        if k == b"cookie":
            c = SimpleCookie()
            c.load(v.decode("latin-1"))
            if COOKIE in c:
                return c[COOKIE].value
    return None


class AuthMiddleware:
    """Pure ASGI middleware so it covers both HTTP and WebSocket."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        path = scope["path"]
        is_api = path.startswith(("/api/", "/ws/"))
        public = path in PUBLIC_EXACT or path.startswith(PUBLIC_PREFIXES) or not is_api
        if public or valid_session(_cookie_from_scope(scope)):
            return await self.app(scope, receive, send)
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 4401})
            return
        body = b'{"detail":"login required"}'
        await send({"type": "http.response.start", "status": 401,
                    "headers": [(b"content-type", b"application/json"),
                                (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})


if __name__ == "__main__":
    cmd = sys.argv[1:2]
    if cmd == ["enroll"]:
        link = new_enroll_link()
        print(f"Open on the device that should hold the passkey (valid {ENROLL_TTL // 60} min, one use):\n\n{link}\n")
        segno.make(link, error="m").terminal(compact=True)
        sys.exit(0)
    if cmd != ["set"]:
        sys.exit("usage: python -m app.auth set [--stdin] | enroll")
    if "--stdin" in sys.argv:
        pw = sys.stdin.readline().strip().strip('"').strip("'")
    else:
        import getpass
        pw = getpass.getpass("New password: ")
    if not pw:
        sys.exit("empty password")
    set_password(pw)
    print(f"password set ({AUTH_FILE})")
    if has_passkeys():
        print("note: passkeys are set up, so password sign-in stays off")
