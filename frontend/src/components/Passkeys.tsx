import { FingerprintPattern, KeyRound, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, usePoll } from "../api";
import { dateTime } from "../format";
import { OriginLink, type AuthStatus, type Flow } from "../pages/Login";
import { createPasskey, deviceName, passkeyError, passkeysSupported } from "../webauthn";
import { Button, Card, Skeleton, Tag } from "./ui";

type Passkey = { id: string; name: string; synced: boolean; created: number; last_used: number | null };

const input =
  "h-10 min-w-0 flex-1 rounded-lg border border-line-strong bg-bg px-3 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none";

/** Settings card: the passkeys that can sign in (and approve QR sign-ins), add and remove them. */
export function Passkeys() {
  const { data, reload } = usePoll<Passkey[]>("/api/passkeys");
  const [origin, setOrigin] = useState<string | null>(null);
  const [name, setName] = useState(deviceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  useEffect(() => {
    api<AuthStatus>("/api/auth/status").then((s) => setOrigin(s.origin)).catch(() => {});
  }, []);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const { flow, options } = await api<Flow>("/api/passkeys/options", { method: "POST" });
      const credential = await createPasskey(options);
      await api("/api/passkeys", { method: "POST", body: JSON.stringify({ flow, credential, name }) });
      reload();
    } catch (err) {
      setError(passkeyError(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await api(`/api/passkeys/${id}`, { method: "DELETE" });
      reload();
    } catch (err) {
      setError(String(err).replace(/^Error: \d+ /, "").replace(/^\{"detail":"(.*)"\}$/, "$1"));
    } finally {
      setConfirming(null);
    }
  };

  const here = origin != null && passkeysSupported() && location.origin === origin;
  const none = data?.length === 0;

  return (
    <Card title="Sign-in" icon={ShieldCheck} className="mt-4">
      {!data ? (
        <Skeleton className="h-24" />
      ) : none ? (
        <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-fg-2">
          Password sign-in is on. Add a passkey and the password stops working: from then on you sign in with
          Touch ID, Face ID, or by scanning the QR code with your phone. Other signed-in browsers get signed out.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {data.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 first:pt-0">
              <KeyRound size={16} className="shrink-0 text-muted" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm text-fg">
                  <span className="truncate">{p.name}</span>
                  {p.synced && <Tag>Synced</Tag>}
                </p>
                <p className="text-xs text-muted">
                  Added {dateTime(p.created)} · {p.last_used ? `last used ${dateTime(p.last_used)}` : "not used yet"}
                </p>
              </div>
              {confirming === p.id ? (
                <div className="flex gap-2">
                  <Button onClick={() => setConfirming(null)}>Cancel</Button>
                  <Button icon={Trash2} onClick={() => remove(p.id)}>Remove</Button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(p.id)}
                  disabled={data.length === 1}
                  title={data.length === 1 ? "Add another passkey before removing the last one" : undefined}
                  aria-label={`Remove passkey ${p.name}`}
                  className="grid size-10 cursor-pointer place-items-center rounded-lg text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-bad disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted"
                >
                  <Trash2 size={16} aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-5 border-t border-line pt-5">
        {here ? (
          <>
            <label htmlFor="pk-name" className="mb-1.5 block text-sm font-medium text-fg-2">Add a passkey on this device</label>
            <div className="flex flex-wrap gap-2">
              <input id="pk-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} className={input} placeholder="Name" />
              <Button variant="primary" icon={busy ? FingerprintPattern : Plus} onClick={add} disabled={busy || !name.trim()}>
                {busy ? "Waiting…" : "Add passkey"}
              </Button>
            </div>
            <p className="mt-1.5 text-xs text-muted">
              Passkeys made on an iPhone or Mac sync to your other Apple devices through iCloud Keychain.
            </p>
          </>
        ) : (
          <p className="text-sm text-fg-2">
            To add a passkey from this device, open {origin ? <OriginLink origin={origin} /> : "the dashboard over HTTPS"}.
          </p>
        )}
        {error && <p role="alert" className="mt-2 text-sm text-bad">{error}</p>}
        <p className="mt-4 text-xs text-muted">
          Lost every device? On the server, in <code className="font-mono text-fg-2">backend/</code>, run{" "}
          <code className="font-mono text-fg-2">.venv/bin/python -m app.auth enroll</code> for a one-time link.
        </p>
      </div>
    </Card>
  );
}
