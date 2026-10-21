# Sign-in and security

The dashboard can open a shell on the server (see [terminal.md](terminal.md)), so signing in is guarded like
an SSH key: **passkeys only**. A password exists just long enough to add the first passkey.

![Sign-in](screenshots/login.png)

## Ways to sign in

| Method | Where it works | How |
|---|---|---|
| **Passkey** | On the public HTTPS origin (`MONITOR_ORIGIN`) | **Sign in with passkey**, then Touch ID, Face ID, Windows Hello, a phone or a security key |
| **QR code** | Anywhere, including `http://<server-ip>:8090` | Scan the code on the sign-in page with your phone, check the two-digit code matches, then **Approve with passkey** on the phone |
| **Password** | Only until the first passkey exists | Bootstrap only, then refused (403) |

Passkeys are bound to one origin (the WebAuthn *relying party*). The default is `https://monitor.lufria.tech`;
set `MONITOR_ORIGIN` for your own domain (see [configuration.md](configuration.md)). Browsers only allow
passkeys in a secure context, so the LAN address over plain http can't use them directly. That is what the
QR sign-in is for: the phone approves on the HTTPS origin, and the waiting browser gets the session.

## First-time setup

1. Set a bootstrap password on the server:
   ```bash
   cd ~/monitor/backend
   .venv/bin/python -m app.auth set
   ```
2. Open the dashboard on the HTTPS origin and sign in with that password.
3. **Settings → Sign-in → Add passkey.** Use a synced passkey (iCloud Keychain, Google Password Manager) so a
   lost device doesn't lock you out, and add a second one on another device.

Adding the **first** passkey:
- turns password sign-in off for good (`POST /api/auth/login` returns 403),
- rotates the session-signing key, which signs out every other browser,
- hands the browser that added it a fresh session cookie, so you stay signed in.

## QR sign-in in detail

1. The waiting browser asks for a QR request and shows a QR code of `<MONITOR_ORIGIN>/approve/<id>`, a
   two-digit code and a 2-minute countdown. It polls with a secret only it knows.
2. The phone opens the link and shows the code, the requesting IP, its device (from the User-Agent) and its
   country (Cloudflare's `CF-IPCountry`, when behind Cloudflare).
3. **Approve with passkey** requires a passkey with user verification (Face ID / Touch ID / PIN), so a phone
   without one can't approve. **Deny** ends the request.
4. On approval, the next poll from the waiting browser receives the session cookie, once.

Requests live in the dashboard's memory: a restart cancels pending ones. A request is single use and
expires after 2 minutes.

## Managing passkeys

**Settings → Sign-in** lists passkeys with their name, whether they're synced, when they were added and last
used. A new passkey is named after the device by default; you can change the name before adding it. You can
add more, or delete one. **The last passkey can't be deleted**, so you can't
lock yourself out from the UI.

## Recovery (every device lost)

On the server (over SSH, or the console):

```bash
cd ~/monitor/backend
.venv/bin/python -m app.auth enroll
```

This prints a one-time link and a QR code to the terminal, valid for **15 minutes**. Open it on the device
that should hold the new passkey; creating the passkey signs that browser in. The link stops working after use.

## Sessions

| | |
|---|---|
| Cookie | `lufria_monitor_session`, HMAC-signed, valid 30 days |
| Flags | `HttpOnly`, `SameSite=Lax`, `Secure` automatically when served over HTTPS (`X-Forwarded-Proto: https` behind a tunnel) |
| Sign out | **Log out** in the sidebar, or `POST /api/auth/logout` |
| Key rotation | Adding the first passkey replaces the signing key, which ends every other session |

## Brute-force protection

Failed password, passkey, QR and enrolment attempts all count toward one limit per client IP: **5 failures in
5 minutes** locks that IP out (HTTP 429) until the window passes. Behind Cloudflare the IP comes from
`CF-Connecting-IP`, otherwise from `X-Forwarded-For` or the socket.

## Cross-site protection

`SameSite=Lax` keeps the cookie off requests from other *sites*, but sibling subdomains of the same domain
(`drive.example.com` next to `monitor.example.com`) count as the same site. Routes that can run commands or
change sign-in (the terminal, `/api/passkeys`) therefore also require `Origin` to match `Host`, and answer 403
otherwise.

## Where things are stored

`data/auth.json`, mode 600, owned by the dashboard user. It holds:
- the bootstrap password's salted PBKDF2-SHA256 hash (until passkeys exist),
- the session-signing secret,
- the passkeys' public keys, sign counters, names and timestamps (no private keys: those never leave your devices).

**If `data/auth.json` doesn't exist, the dashboard is open to anyone who can reach it.** Set the bootstrap
password before exposing it.

## Hardening checklist

- Don't expose the dashboard before step 3 of the first-time setup is done.
- Put Cloudflare Access (email one-time code, or your identity provider) in front of the public hostname as a
  second lock.
- If the dashboard user has passwordless `sudo`, a dashboard session is root. Consider removing that, or
  binding the dashboard to `127.0.0.1` (`HOST=127.0.0.1 sudo deploy/install.sh`) and reaching it only through
  the tunnel.
- The `docker` group is root-equivalent too; `deploy/install.sh` adds it when the group exists (see
  [setup.md](setup.md#4-install-the-services)).
