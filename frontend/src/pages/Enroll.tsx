import { CircleCheck, FingerprintPattern, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { createPasskey, deviceName, passkeyError, passkeysSupported } from "../webauthn";
import { AuthScreen, OriginLink, type AuthStatus, type Flow } from "./Login";

/** One-time link from `python -m app.auth enroll`: adds a passkey without being signed in. */
export function Enroll({ token }: { token: string }) {
  const [origin, setOrigin] = useState<string | null>(null);
  const [name, setName] = useState(deviceName);
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Add a passkey · Lufria Monitor";
    api<AuthStatus>("/api/auth/status").then((s) => setOrigin(s.origin)).catch(() => setOrigin(location.origin));
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setState("busy");
    setError(null);
    try {
      const { flow, options } = await api<Flow>("/api/auth/enroll/options", { method: "POST", body: JSON.stringify({ token }) });
      const credential = await createPasskey(options);
      await api("/api/auth/enroll", { method: "POST", body: JSON.stringify({ token, flow, credential, name }) });
      setState("done");
    } catch (err) {
      setError(String(err).includes("404") ? "This link has expired or was already used. Make a new one on the server." : passkeyError(err));
      setState("idle");
    }
  };

  if (state === "done") {
    return (
      <AuthScreen title="Passkey added" subtitle="Lufria Monitor">
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-line bg-surface p-6 text-center" role="status">
          <CircleCheck size={28} className="text-good" aria-hidden />
          <p className="text-sm text-fg-2">You're signed in. Next time, use the passkey or scan the QR code.</p>
          <button
            type="button"
            onClick={() => location.replace("/")}
            className="inline-flex h-11 w-full cursor-pointer items-center justify-center rounded-lg bg-accent text-sm font-semibold text-bg transition-colors duration-150 hover:bg-accent/90"
          >
            Open dashboard
          </button>
        </div>
      </AuthScreen>
    );
  }

  const here = origin != null && passkeysSupported() && location.origin === origin;
  return (
    <AuthScreen title="Add a passkey" subtitle="One-time link from the server">
      <form onSubmit={create} className="rounded-2xl border border-line bg-surface p-6">
        {origin != null && !here ? (
          <p className="text-sm text-fg-2">
            Passkeys only work on <OriginLink origin={origin} />. Open this link there.
          </p>
        ) : (
          <>
            <label htmlFor="pk-name" className="mb-1.5 block text-sm font-medium text-fg-2">Name</label>
            <input
              id="pk-name"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              className="h-11 w-full rounded-lg border border-line-strong bg-bg px-3 text-sm text-fg focus:border-accent focus:outline-none"
            />
            <p className="mt-1.5 text-xs text-muted">So you can tell your passkeys apart in Settings.</p>
            <button
              type="submit"
              disabled={state === "busy" || origin == null}
              className="mt-5 inline-flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-accent text-sm font-semibold text-bg transition-colors duration-150 hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {state === "busy" ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <FingerprintPattern size={16} aria-hidden />}
              {state === "busy" ? "Waiting for passkey…" : "Create passkey"}
            </button>
            {error && <p role="alert" className="mt-2 text-sm text-bad">{error}</p>}
          </>
        )}
      </form>
    </AuthScreen>
  );
}
