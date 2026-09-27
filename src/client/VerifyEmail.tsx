import { useEffect, useState } from "react";
import { Brand, Button, Icon } from "./ui";

// `/verify?token=…` — the landing page for the welcome / confirm-email link. Deliberately
// standalone: it must work in a fresh browser where the person is signed out (they clicked
// from their phone's mail app), and it must never depend on workspace state loading first.
type Peek = { ok: true; already: boolean; email: string };
type Done = { ok: true; email: string; signed_in: boolean };

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(`/api/app${path}`, { method, credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const j = (await r.json().catch(() => ({}))) as { error?: string; message?: string } & T;
  if (!r.ok) throw new Error(j.message || j.error || "Something went wrong.");
  return j;
}

export function VerifyEmail() {
  const token = new URLSearchParams(location.search).get("token") || "";
  const [peek, setPeek] = useState<Peek | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [error, setError] = useState(token ? "" : "This confirmation link is missing its code. Open the link from your email again.");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!token) return;
    call<Peek>(`/auth/verify-email/peek?token=${encodeURIComponent(token)}`).then(setPeek).catch((e: Error) => setError(e.message));
  }, [token]);
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      setDone(await call<Done>("/auth/verify-email", "POST", { token }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not confirm this address.");
    } finally {
      setBusy(false);
    }
  }
  const settled = done || (peek?.already ? { ok: true as const, email: peek.email, signed_in: false } : null);
  return (
    <div className="auth-screen">
      <aside className="auth-brand" aria-hidden="true">
        <img className="auth-brand-logo" src="/static/brand/foliyo-wordmark-white.svg" alt="foliyo" width={128} height={48} />
        <div className="auth-brand-copy">
          <p className="auth-brand-eyebrow">Booking software for any appointment business</p>
          <h1>Built for people<br />who run on appointments.</h1>
          <p className="auth-brand-tag">Book · Manage · Show up</p>
        </div>
      </aside>
      <div className="auth-main">
        <section className="workspace-panel account-entry auth-card" aria-labelledby="verify-heading" data-testid="verify-page">
          <Brand />
          <h2 id="verify-heading">{settled ? "Email confirmed" : error ? "This link isn't valid" : "Confirm your email"}</h2>
          {settled ? (
            <div className="auth-sent" role="status" data-testid="verify-done">
              <Icon name="check" />
              <p>
                <strong>{settled.email}</strong> is confirmed{peek?.already && !done ? " — it already was" : ""}. Password resets and sign-in help will go there.
              </p>
              <a className="button primary" href="/workspace" data-testid="verify-continue">{settled.signed_in ? "Back to your workspace" : "Sign in"}</a>
            </div>
          ) : error ? (
            <div className="auth-sent" role="alert" data-testid="verify-error">
              <Icon name="alert" />
              <p>{error}</p>
              <a className="button primary" href="/signin">Sign in</a>
              <p className="helper">Once you're in, the banner at the top of your workspace can send a fresh link.</p>
            </div>
          ) : peek ? (
            <>
              <p>Confirm that <strong>{peek.email}</strong> is your sign-in address. This is where password resets and account messages will go.</p>
              <Button onClick={confirm} disabled={busy} data-testid="verify-confirm">{busy ? "Confirming…" : "Yes, that's my email"}</Button>
              <p className="helper">Not you? Just close this page — nothing happens until the button is pressed.</p>
            </>
          ) : (
            <p role="status">Checking your link…</p>
          )}
        </section>
      </div>
    </div>
  );
}
