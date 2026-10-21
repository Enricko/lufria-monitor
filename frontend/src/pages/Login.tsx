import { CircleCheck, CircleX, Eye, EyeOff, FingerprintPattern, Loader2, LogIn, RefreshCw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { Button, Skeleton } from "../components/ui";
import { getPasskey, passkeyError, passkeysSupported } from "../webauthn";

export type AuthStatus = { enabled: boolean; authenticated: boolean; password: boolean; passkeys: boolean; origin: string };
export type Flow = { flow: string; options: Record<string, unknown> };

export function Login({ onLogin }: { onLogin: () => void }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);

  useEffect(() => {
    api<AuthStatus>("/api/auth/status").then(setStatus).catch(() => setStatus(null));
  }, []);

  return (
    <AuthScreen subtitle="Sign in to continue">
      {!status ? (
        <Skeleton className="h-96" />
      ) : status.passkeys ? (
        <PasskeySignIn origin={status.origin} onLogin={onLogin} />
      ) : (
        <PasswordSignIn onLogin={onLogin} />
      )}
    </AuthScreen>
  );
}

/** Centered logo + title + one card, shared by the sign-in, approve and enrol pages. */
export function AuthScreen({ title = "Lufria Monitor", subtitle, children }: { title?: string; subtitle: ReactNode; children: ReactNode }) {
  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <img src="/favicon.svg" alt="" className="size-12" />
          <h1 className="mt-4 text-xl font-semibold">{title}</h1>
          <p className="mt-1 text-sm text-muted">{subtitle}</p>
        </div>
        {children}
      </div>
    </main>
  );
}

/** Link to the one origin where passkeys work, keeping the current page. */
export function OriginLink({ origin }: { origin: string }) {
  return (
    <a href={origin + location.pathname + location.hash} className="font-medium text-accent underline-offset-2 hover:underline">
      {new URL(origin).host}
    </a>
  );
}

function PasskeySignIn({ origin, onLogin }: { origin: string; onLogin: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const here = passkeysSupported() && location.origin === origin;

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const { flow, options } = await api<Flow>("/api/auth/passkey/options", { method: "POST" });
      const credential = await getPasskey(options);
      await api("/api/auth/passkey", { method: "POST", body: JSON.stringify({ flow, credential }) });
      onLogin();
    } catch (err) {
      setError(passkeyError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-line bg-surface p-6">
      {here ? (
        <>
          <button
            type="button"
            onClick={signIn}
            disabled={busy}
            autoFocus
            className="inline-flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-accent text-sm font-semibold text-bg transition-colors duration-150 hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <FingerprintPattern size={16} aria-hidden />}
            {busy ? "Waiting for passkey…" : "Sign in with passkey"}
          </button>
          <p className="mt-2 text-center text-xs text-muted">Touch ID, Face ID, or your phone</p>
          {error && <p role="alert" className="mt-2 text-center text-sm text-bad">{error}</p>}
        </>
      ) : (
        <p className="text-center text-sm text-fg-2">
          Passkeys only work on <OriginLink origin={origin} />. Here, scan the code with your phone.
        </p>
      )}
      <div className="my-6 flex items-center gap-3 text-xs text-muted" aria-hidden>
        <span className="h-px flex-1 bg-line" />
        or scan with your phone
        <span className="h-px flex-1 bg-line" />
      </div>
      <QrSignIn onLogin={onLogin} />
    </div>
  );
}

type QrRequest = { id: string; poll: string; code: string; url: string; qr: string; expires_in: number };
type QrState = "loading" | "pending" | "approved" | "denied" | "expired" | "error";

function QrSignIn({ onLogin }: { onLogin: () => void }) {
  const [req, setReq] = useState<QrRequest | null>(null);
  const [state, setState] = useState<QrState>("loading");
  const [left, setLeft] = useState(0);
  const [round, setRound] = useState(0); // bump for a new code

  useEffect(() => {
    let alive = true;
    setState("loading");
    api<QrRequest>("/api/auth/qr", { method: "POST" })
      .then((r) => {
        if (!alive) return;
        setReq(r);
        setLeft(r.expires_in);
        setState("pending");
      })
      .catch(() => alive && setState("error"));
    return () => {
      alive = false;
    };
  }, [round]);

  // Poll until the phone answers. One request at a time, so a slow tunnel can't stack them up.
  useEffect(() => {
    if (!req || state !== "pending") return;
    let stop = false;
    const deadline = Date.now() + req.expires_in * 1000;
    const tick = setInterval(() => setLeft(Math.max(0, Math.round((deadline - Date.now()) / 1000))), 1000);
    (async () => {
      while (!stop) {
        await new Promise((r) => setTimeout(r, 1500));
        if (stop) return;
        if (Date.now() > deadline) return setState("expired");
        try {
          const { status } = await api<{ status: QrState }>(`/api/auth/qr/${req.id}/poll`, {
            method: "POST",
            body: JSON.stringify({ poll: req.poll }),
          });
          if (stop) return;
          if (status === "approved") {
            setState("approved");
            return onLogin();
          }
          if (status !== "pending") return setState(status);
        } catch {
          // network blip: keep polling
        }
      }
    })();
    return () => {
      stop = true;
      clearInterval(tick);
    };
  }, [req, state, onLogin]);

  // An expired code renews itself, but only while someone can see it
  useEffect(() => {
    if (state !== "expired") return;
    const renew = () => document.visibilityState === "visible" && setRound((n) => n + 1);
    renew();
    document.addEventListener("visibilitychange", renew);
    return () => document.removeEventListener("visibilitychange", renew);
  }, [state]);

  const again = (
    <Button icon={RefreshCw} onClick={() => setRound((n) => n + 1)}>
      New code
    </Button>
  );

  return (
    <div className="flex flex-col items-center text-center" aria-live="polite">
      {state === "pending" && req ? (
        <>
          <img src={req.qr} alt="QR code: scan it with your phone to sign in" className="size-48 rounded-xl bg-white" />
          <p className="mt-3 text-sm text-fg-2">
            Code <span className="tnum font-mono text-base font-semibold text-fg">{req.code}</span>
            <span className="text-muted"> · {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</span>
          </p>
          <p className="mt-1 text-xs text-muted">Scan with your phone's camera, check the code matches, then approve with Face ID or Touch ID.</p>
        </>
      ) : state === "approved" ? (
        <Outcome icon={<CircleCheck size={28} className="text-good" aria-hidden />} text="Approved. Signing in…" />
      ) : state === "denied" ? (
        <Outcome icon={<CircleX size={28} className="text-bad" aria-hidden />} text="Denied on your phone." action={again} />
      ) : state === "error" ? (
        <Outcome icon={<CircleX size={28} className="text-bad" aria-hidden />} text="Couldn't make a code." action={again} />
      ) : (
        <Skeleton className="size-48 rounded-xl" />
      )}
    </div>
  );
}

function Outcome({ icon, text, action }: { icon: ReactNode; text: string; action?: ReactNode }) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center gap-3">
      {icon}
      <p className="text-sm text-fg-2">{text}</p>
      {action}
    </div>
  );
}

function PasswordSignIn({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) });
      onLogin();
    } catch (err) {
      setError(String(err).includes("429") ? "Too many attempts. Try again in 5 minutes." : "That password isn't right.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="rounded-2xl border border-line bg-surface p-6">
      <label htmlFor="pw" className="mb-1.5 block text-sm font-medium text-fg-2">Password</label>
      <div className="relative">
        <input
          id="pw"
          type={show ? "text" : "password"}
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={!!error}
          aria-describedby={error ? "pw-error" : undefined}
          className="h-11 w-full rounded-lg border border-line-strong bg-bg pl-3 pr-11 text-sm text-fg focus:border-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={() => setShow(!show)}
          aria-label={show ? "Hide password" : "Show password"}
          className="absolute right-0 top-0 grid size-11 cursor-pointer place-items-center text-muted hover:text-fg"
        >
          {show ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
        </button>
      </div>
      {error && <p id="pw-error" role="alert" className="mt-2 text-sm text-bad">{error}</p>}
      <button
        type="submit"
        disabled={busy || !password}
        className="mt-5 inline-flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-accent text-sm font-semibold text-bg transition-colors duration-150 hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <LogIn size={16} aria-hidden />}
        {busy ? "Signing in…" : "Sign in"}
      </button>
      <p className="mt-4 text-xs text-muted">
        After signing in, add a passkey under Settings. From then on the password stops working and you sign in
        with Touch ID, Face ID or a QR code.
      </p>
    </form>
  );
}
