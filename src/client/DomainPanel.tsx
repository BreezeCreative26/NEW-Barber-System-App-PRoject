// Settings → Your web address. The shop types a domain once; we show exactly which DNS records to add
// at their registrar and report, in plain words, whether the booking site and the email sender are ready.
// Until each half is ready the foliyo address and sender keep working, so nothing breaks while DNS catches up.
import { useEffect, useState } from "react";
import { Button } from "./ui";

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Rec = { purpose: "web" | "email"; type: string; host: string; value: string; priority?: number; status: string };
type State = {
  allowed: boolean; configured: boolean; foliyo_url: string;
  domain: null | { domain: string; web: string; mail: string; records: Rec[]; error: string; checked_at: number; url: string; live: boolean };
};
const say = (s: string) => (s === "VERIFIED" ? "Ready" : s === "ERROR" ? "Needs attention" : "Waiting for your DNS records");

export function DomainPanel({ api, isOwner }: { api: Api; isOwner: boolean }) {
  const [st, setSt] = useState<State | null>(null);
  const [input, setInput] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const load = () => api<State>("/domain").then(setSt).catch((e) => setErr(e instanceof Error ? e.message : "Could not load."));
  useEffect(() => { void load(); }, []);
  // While something is still pending, look again every 20 seconds so the page turns green by itself.
  useEffect(() => {
    if (!st?.domain || (st.domain.web === "VERIFIED" && st.domain.mail === "VERIFIED")) return;
    const t = window.setInterval(() => { api<State>("/domain/check", "POST").then(setSt).catch(() => null); }, 20000);
    return () => window.clearInterval(t);
  }, [st?.domain?.web, st?.domain?.mail, st?.domain?.domain]);
  if (!isOwner) return <p className="workspace-footnote">Only the owner can change the shop's web address.</p>;
  if (!st) return <p className="workspace-footnote">{err || "Loading…"}</p>;
  const run = async (what: string, f: () => Promise<State>) => { setBusy(what); setErr(""); try { setSt(await f()); } catch (e) { setErr(e instanceof Error ? e.message : "Something went wrong."); } finally { setBusy(""); } };
  const d = st.domain;

  if (!st.allowed) return (
    <section className="workspace-panel" data-testid="domain-locked">
      <h3>Use your own web address</h3>
      <p>Customers book on <strong>{st.foliyo_url || "your foliyo address"}</strong>. With your own address (for example <code>book.yourshop.co.uk</code>) they book there, and their emails come from <code>bookings@yourshop.co.uk</code> under your shop's name.</p>
      <p className="workspace-footnote">This isn't part of your plan yet. Contact foliyo to switch it on.</p>
    </section>
  );

  return (
    <section className="workspace-panel dom" data-testid="domain-panel">
      {!d ? (
        <>
          <h3>Use your own web address</h3>
          <p>Enter a domain you own. We'll show the records to add where you bought it. Customers still use <strong>{st.foliyo_url || "your foliyo address"}</strong> until everything is ready, so nothing breaks in between.</p>
          <form className="dom-form" onSubmit={(e) => { e.preventDefault(); void run("save", () => api<State>("/domain", "PUT", { domain: input })); }}>
            <label>Your web address
              <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="book.yourshop.co.uk" autoCapitalize="off" autoCorrect="off" spellCheck={false} data-testid="domain-input" />
            </label>
            <Button type="submit" disabled={busy === "save" || !input.trim()} data-testid="domain-save">{busy === "save" ? "Connecting…" : "Connect"}</Button>
          </form>
          {!st.configured && <p className="workspace-footnote" data-testid="domain-unconfigured">foliyo hasn't finished switching this on for the platform yet. You can enter your address, but it won't go live until we do.</p>}
        </>
      ) : (
        <>
          <header className="dom-head">
            <div><h3>{d.domain}</h3><small>{d.live ? <>Customers book at <a href={d.url} target="_blank" rel="noopener noreferrer">{d.url}</a></> : <>Customers still use {st.foliyo_url || "your foliyo address"} until the web address is ready.</>}</small></div>
          </header>
          <ul className="dom-status" data-testid="domain-status">
            <li data-state={d.web}><b>Booking site</b><span data-testid="domain-web">{say(d.web)}</span></li>
            <li data-state={d.mail}><b>Emails from your address</b><span data-testid="domain-mail">{say(d.mail)}</span></li>
          </ul>
          {d.web === "VERIFIED" && d.mail === "VERIFIED" && <p className="workspace-success" role="status">All set. Booking links in every email now use your address, and emails come from <code>bookings@{d.domain}</code> under your shop's name.</p>}
          {d.error && <p className="workspace-error" role="status" data-testid="domain-error">{d.error}</p>}
          {d.records.some((r) => r.status !== "verified") && (
            <>
              <h4>Add these records where you bought your domain</h4>
              <p className="workspace-footnote">Log in to your domain provider (GoDaddy, 123-reg, Cloudflare and so on), open DNS settings, and add each row exactly. It can take a few minutes, sometimes a few hours. This page checks for you.</p>
              <div className="dom-scroll"><table className="dom-records" data-testid="domain-records">
                <thead><tr><th>For</th><th>Type</th><th>Name</th><th>Value</th><th /></tr></thead>
                <tbody>
                  {d.records.map((r, i) => (
                    <tr key={i} data-state={r.status}>
                      <td>{r.purpose === "web" ? "Booking site" : "Email"}</td>
                      <td>{r.type}{r.priority != null ? ` (priority ${r.priority})` : ""}</td>
                      <td><code>{r.host}</code></td>
                      <td><code className="dom-val">{r.value}</code> <button type="button" className="link" onClick={() => void navigator.clipboard?.writeText(r.value)}>Copy</button></td>
                      <td>{r.status === "verified" ? "✓" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </>
          )}
          <div className="dom-actions">
            <Button variant="secondary" disabled={busy === "check"} onClick={() => void run("check", () => api<State>("/domain/check", "POST"))} data-testid="domain-check">{busy === "check" ? "Checking…" : "Check now"}</Button>
            <Button variant="secondary" disabled={busy === "remove"} onClick={() => { if (window.confirm(`Disconnect ${d.domain}? Customers will use ${st.foliyo_url || "your foliyo address"} again.`)) void run("remove", () => api<State>("/domain", "DELETE")); }} data-testid="domain-remove">Disconnect</Button>
          </div>
        </>
      )}
      {err && <p className="workspace-error" role="alert" data-testid="domain-fail">{err}</p>}
    </section>
  );
}
