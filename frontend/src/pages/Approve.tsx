import { CircleCheck, CircleX, FingerprintPattern, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { Skeleton } from "../components/ui";
import { getPasskey, passkeyError, passkeysSupported } from "../webauthn";
import { AuthScreen, type Flow } from "./Login";

type Info = { code: string; ip: string; device: string; country: string | null; created: number; expires: number };

/** Opened from the QR code on the phone: approve (with the passkey) or deny another screen's sign-in. */
export function Approve({ id }: { id: string }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "busy" | "approved" | "denied" | "gone">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Approve sign-in · Lufria Monitor";
    api<Info>(`/api/auth/qr/${id}`)
      .then((i) => {
        setInfo(i);
        setState("ready");
      })
      .catch(() => setState("gone"));
  }, [id]);

  const approve = async () => {
    setState("busy");
    setError(null);
    try {
      const { flow, options } = await api<Flow>(`/api/auth/qr/${id}/options`, { method: "POST" });
      const credential = await getPasskey(options);
      await api(`/api/auth/qr/${id}/approve`, { method: "POST", body: JSON.stringify({ flow, credential }) });
      setState("approved");
    } catch (err) {
      setError(passkeyError(err));
      setState(String(err).includes("404") ? "gone" : "ready");
    }
  };

  const deny = () => {
    api(`/api/auth/qr/${id}/deny`, { method: "POST" }).finally(() => setState("denied"));
  };

  if (state === "loading") {
    return (
      <AuthScreen title="Approve sign-in" subtitle="Lufria Monitor">
        <Skeleton className="h-80" />
      </AuthScreen>
    );
  }
  if (state === "approved" || state === "denied" || state === "gone" || !info) {
    const ok = state === "approved";
    return (
      <AuthScreen title={ok ? "Approved" : state === "denied" ? "Denied" : "Code expired"} subtitle="Lufria Monitor">
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-surface p-6 text-center" role="status">
          {ok ? <CircleCheck size={28} className="text-good" aria-hidden /> : <CircleX size={28} className="text-bad" aria-hidden />}
          <p className="text-sm text-fg-2">
            {ok
              ? "The other screen is signing in now. You can close this tab."
              : state === "denied"
                ? "Nothing was signed in. You can close this tab."
                : "This code was already used or has expired. Scan the new code on the other screen."}
          </p>
        </div>
      </AuthScreen>
    );
  }

  const busy = state === "busy";
  return (
    <AuthScreen title="Approve sign-in?" subtitle="Someone wants to sign in to Lufria Monitor">
      <div className="rounded-2xl border border-line bg-surface p-6">
        <dl className="space-y-3 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Device</dt>
            <dd className="text-right text-fg">{info.device}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">From</dt>
            <dd className="break-all text-right font-mono text-xs text-fg">
              {info.ip}
              {info.country && ` · ${info.country}`}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-muted">Code on that screen</dt>
            <dd className="tnum font-mono text-2xl font-semibold text-fg">{info.code}</dd>
          </div>
        </dl>
        <p className="mt-5 rounded-lg bg-bg px-3 py-2 text-xs text-fg-2">
          Only approve if that screen is in front of you and shows the same code. Approving signs it in for 30 days.
        </p>
        {passkeysSupported() ? (
          <button
            type="button"
            onClick={approve}
            disabled={busy}
            className="mt-5 inline-flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-accent text-sm font-semibold text-bg transition-colors duration-150 hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <FingerprintPattern size={16} aria-hidden />}
            {busy ? "Waiting for passkey…" : "Approve with passkey"}
          </button>
        ) : (
          <p className="mt-5 text-sm text-bad">This browser can't use passkeys. Open the link in Safari or Chrome.</p>
        )}
        {error && <p role="alert" className="mt-2 text-center text-sm text-bad">{error}</p>}
        <button
          type="button"
          onClick={deny}
          disabled={busy}
          className="mt-3 inline-flex h-11 w-full cursor-pointer items-center justify-center rounded-lg border border-line-strong bg-surface-2 text-sm font-medium text-fg transition-colors duration-150 hover:border-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          Deny
        </button>
      </div>
    </AuthScreen>
  );
}
