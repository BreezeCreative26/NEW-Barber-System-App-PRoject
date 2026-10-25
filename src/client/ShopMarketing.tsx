// Marketing: a shop's own campaigns to its own customers, by email and text. Pick a type, edit the
// words, see exactly who gets it and what it costs, then send now or later. Branded as the shop.
import { useEffect, useRef, useState } from "react";
import { Button, Icon } from "./ui";

type Audience = "ALL" | "OPTED_IN" | "RECENT" | "LAPSED" | "NONE";
type Channel = "SMS" | "EMAIL" | "BOTH";
type Preset = { kind: string; title: string; blurb: string; audience: Audience; channel: Channel; copy: { subject: string; heading: string; body: string; cta_label: string; sms_body: string } };
type Campaign = { id: string; name: string; kind: string; channel: string; created_at: number; scheduled_for: number; sms_count: number; email_count: number; sent: number; failed: number; waiting: number };
type Info = { campaigns: Campaign[]; presets: Preset[]; link: string; sms_on: boolean; email_on: boolean; sms_acked: boolean; sms_pence: number; has_page: boolean };
type Prev = { problems: string[]; customers: number; sms: number; email: number; landline: number; no_contact: number; sms_text: string; sms_length: number; email_html: string | null; cost_pence: number; sms_window_open: boolean; held_back?: number };

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(`/api/app${path}`, { method, credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string; message?: string }).error || (j as { message?: string }).message || "Something went wrong.");
  return j as T;
}
const gbp = (p: number) => `£${(p / 100).toFixed(2)}`;
const when = (t: number) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const AUDIENCES: { v: Audience; label: string; hint: string }[] = [
  { v: "ALL", label: "All my customers", hint: "Everyone you have contact details for" },
  { v: "RECENT", label: "Recent customers", hint: "Visited in the last 3 months" },
  { v: "LAPSED", label: "Not seen in a while", hint: "Visited before, but not in the last 2 months" },
  { v: "NONE", label: "Only the list I upload", hint: "Nobody from your customer list, just the people in your CSV" },
  { v: "OPTED_IN", label: "Agreed to marketing", hint: "Only people who ticked the box themselves" },
];
const KIND_ICON: Record<string, string> = { launch: "globe", offer: "star", quiet: "calendar", winback: "users", hours: "clock", service: "scissors", custom: "edit" };
const localInput = (t: number) => { const d = new Date(t); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

export function ShopMarketing() {
  const [info, setInfo] = useState<Info | null>(null);
  const [err, setErr] = useState("");
  const [kind, setKind] = useState<string | null>(null);
  const load = () => call<Info>("/announcements").then(setInfo).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  if (err && !info) return <p className="workspace-error" role="alert">{err}</p>;
  if (!info) return <p>Loading...</p>;
  if (!info.has_page) return <section className="workspace-panel"><p>Set your shop address in Settings first, so customers have a page to book on.</p></section>;
  const preset = info.presets.find((p) => p.kind === kind);
  if (preset) return <Composer info={info} preset={preset} onBack={() => { setKind(null); load(); }} />;
  return (
    <div className="mkt" data-testid="marketing">
      <section className="mkt-types" aria-label="Campaign types">
        {info.presets.map((p) => (
          <button key={p.kind} type="button" className="mkt-type" onClick={() => setKind(p.kind)} data-testid={`mkt-type-${p.kind}`}>
            <span className="mkt-type-ic"><Icon name={KIND_ICON[p.kind] || "message"} size={20} /></span>
            <b>{p.title}</b>
            <small>{p.blurb}</small>
            <span className="mkt-type-go">Start <Icon name="right" size={14} /></span>
          </button>
        ))}
      </section>
      <section className="workspace-panel">
        <h2>Your campaigns</h2>
        {info.campaigns.length === 0 && <p className="workspace-footnote">Nothing sent yet. Pick a type above to start.</p>}
        <ul className="mkt-list">
          {info.campaigns.map((c) => {
            const kindTitle = info.presets.find((p) => p.kind === c.kind)?.title || "Campaign";
            const scheduled = c.scheduled_for > Date.now();
            return (
              <li key={c.id}>
                <div><b>{c.name || kindTitle}</b><small>{kindTitle} · {c.channel === "BOTH" ? "email and text" : c.channel === "SMS" ? "text" : "email"} · {scheduled ? `scheduled for ${when(c.scheduled_for)}` : when(c.created_at)}</small></div>
                <div className="mkt-stats"><span>{c.sent} sent</span>{c.waiting > 0 && <span>{c.waiting} waiting</span>}{c.failed > 0 && <span className="bad">{c.failed} failed</span>}</div>
                {c.waiting > 0 && <Button variant="ghost" onClick={async () => { await call(`/announcements/${c.id}/cancel`, "POST"); load(); }}>Stop the rest</Button>}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function Composer({ info, preset, onBack }: { info: Info; preset: Preset; onBack: () => void }) {
  const first: Channel = preset.channel === "SMS" && !info.sms_on ? "EMAIL" : preset.channel === "BOTH" && !info.sms_on ? "EMAIL" : preset.channel === "EMAIL" && !info.email_on ? "SMS" : preset.channel;
  const [f, setF] = useState({ kind: preset.kind, channel: first, audience: preset.audience, contact_ids: [] as string[], ...preset.copy });
  const [list, setList] = useState<{ name: string; added: number; skipped: number; with_mobile: number; with_email: number } | null>(null);
  const [upBusy, setUpBusy] = useState(false);
  const [when_, setWhen] = useState<"now" | "later">("now");
  const [at, setAt] = useState(localInput(Date.now() + 24 * 3600000));
  const [prev, setPrev] = useState<Prev | null>(null);
  const [err, setErr] = useState(""); const [note, setNote] = useState(""); const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false); const [ack, setAck] = useState(false);
  const [done, setDone] = useState<{ sms: number; email: number } | null>(null);
  const [pane, setPane] = useState<"edit" | "preview">("edit");
  const timer = useRef<number | undefined>(undefined);
  const body = { ...f, send_at: when_ === "later" ? new Date(at).getTime() : undefined };

  useEffect(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { call<Prev>("/announcements/preview", "POST", { ...f }).then((p) => { setPrev(p); setErr(""); }).catch((e) => setErr(e.message)); }, 450);
    return () => window.clearTimeout(timer.current);
  }, [f]);

  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const needAck = !!prev && prev.sms > 0 && !info.sms_acked;
  const total = prev ? Math.max(prev.sms, prev.email) : 0;
  const blocked = (prev?.problems.length ?? 0) > 0;
  const laterBad = when_ === "later" && !(new Date(at).getTime() > Date.now());

  async function upload(file: File | undefined) {
    if (!file) return;
    setUpBusy(true); setErr("");
    try {
      const csv = await file.text();
      const r = await call<{ ids: string[]; added: number; skipped: number; with_mobile: number; with_email: number }>("/announcements/contacts", "POST", { csv });
      if (!r.added) throw new Error("No names, mobile numbers or email addresses found in that file.");
      setList({ name: file.name, added: r.added, skipped: r.skipped, with_mobile: r.with_mobile, with_email: r.with_email });
      set("contact_ids", r.ids);
    } catch (e) { setErr((e as Error).message); } finally { setUpBusy(false); }
  }
  async function test() {
    setBusy(true); setErr(""); setNote("");
    try { const r = await call<{ sent_to: string }>("/announcements/test", "POST", { ...f }); setNote(`Test email sent to ${r.sent_to}.`); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function send() {
    setBusy(true); setErr("");
    try { setDone(await call<{ sms: number; email: number }>("/announcements/send", "POST", { ...body, confirm: true, sms_ack: ack || undefined })); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  if (done) {
    return (
      <section className="workspace-panel mkt-done" data-testid="mkt-done">
        <h2>{when_ === "later" ? "Scheduled" : "On its way"}</h2>
        <p className="workspace-success" role="status">{plural(done.email, "email")} and {plural(done.sms, "text")} {when_ === "later" ? `will go out on ${when(new Date(at).getTime())}` : "queued"}. {done.sms > 0 && when_ === "now" && !prev?.sms_window_open ? "Texts wait for 09:00 (Monday to Saturday) and then go automatically." : ""}</p>
        <Button onClick={onBack}>Back to marketing</Button>
      </section>
    );
  }
  return (
    <div className="mkt-composer" data-pane={pane} data-testid="mkt-composer">
      <div className="mkt-bar">
        <Button variant="ghost" onClick={onBack}><Icon name="left" size={16} /> All campaigns</Button>
        <h2>{preset.title}</h2>
        <div className="mkt-pane-toggle" role="group" aria-label="Show">
          <button type="button" aria-pressed={pane === "edit"} onClick={() => setPane("edit")}>Edit</button>
          <button type="button" aria-pressed={pane === "preview"} onClick={() => setPane("preview")}>Preview</button>
        </div>
      </div>
      <div className="mkt-cols">
        <div className="mkt-edit">
          <section className="workspace-panel">
            <h3>Who and how</h3>
            <div className="mkt-seg" role="group" aria-label="Send by">
              {info.email_on && <button type="button" aria-pressed={f.channel === "EMAIL"} onClick={() => set("channel", "EMAIL")} data-testid="mkt-ch-email">Email<small>free</small></button>}
              {info.sms_on && <button type="button" aria-pressed={f.channel === "SMS"} onClick={() => set("channel", "SMS")} data-testid="mkt-ch-sms">Text<small>{info.sms_pence}p each</small></button>}
              {info.email_on && info.sms_on && <button type="button" aria-pressed={f.channel === "BOTH"} onClick={() => set("channel", "BOTH")} data-testid="mkt-ch-both">Both</button>}
            </div>
            <label className="workspace-field"><span>Customers</span>
              <select value={f.audience} onChange={(e) => set("audience", e.target.value as Audience)} data-testid="mkt-audience">
                {AUDIENCES.map((a) => <option key={a.v} value={a.v}>{a.label}</option>)}
              </select>
              <small>{AUDIENCES.find((a) => a.v === f.audience)?.hint}</small>
            </label>
            <div className="mkt-when">
              <label><input type="radio" name="when" checked={when_ === "now"} onChange={() => setWhen("now")} /> Send now</label>
              <label><input type="radio" name="when" checked={when_ === "later"} onChange={() => setWhen("later")} data-testid="mkt-later" /> Choose a time</label>
              {when_ === "later" && <input type="datetime-local" value={at} min={localInput(Date.now())} onChange={(e) => setAt(e.target.value)} aria-label="Send at" data-testid="mkt-at" />}
            </div>
          </section>
          <section className="workspace-panel" data-testid="mkt-upload">
            <h3>Add people from a CSV</h3>
            <p className="workspace-footnote">A spreadsheet saved as CSV with a name, mobile number and email address for each person. They are for this campaign only: they are not added to your customer list, and they stay out of your customers, bookings and reports.</p>
            {list ? (
              <div className="mkt-file">
                <div><b>{list.added} people added</b><small>{list.name} · {list.with_mobile} mobiles · {list.with_email} emails{list.skipped ? ` · ${list.skipped} skipped` : ""}</small></div>
                <Button variant="ghost" onClick={() => { setList(null); set("contact_ids", []); }} data-testid="mkt-list-remove">Remove</Button>
              </div>
            ) : (
              <label className="mkt-drop">
                <input type="file" accept=".csv,text/csv,text/plain" onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ""; }} data-testid="mkt-csv" />
                <Icon name="upload" size={18} /> {upBusy ? "Reading..." : "Choose a CSV file"}
              </label>
            )}
          </section>
          {f.channel !== "SMS" && (
            <section className="workspace-panel">
              <h3>Email</h3>
              <label className="workspace-field"><span>Subject</span><input value={f.subject} onChange={(e) => set("subject", e.target.value)} maxLength={150} data-testid="mkt-subject" /></label>
              <label className="workspace-field"><span>Heading</span><input value={f.heading} onChange={(e) => set("heading", e.target.value)} maxLength={150} /></label>
              <label className="workspace-field"><span>Message</span><textarea rows={7} value={f.body} onChange={(e) => set("body", e.target.value)} maxLength={3000} data-testid="mkt-body" /></label>
              <label className="workspace-field"><span>Button</span><input value={f.cta_label} onChange={(e) => set("cta_label", e.target.value)} maxLength={40} /></label>
            </section>
          )}
          {f.channel !== "EMAIL" && (
            <section className="workspace-panel">
              <h3>Text</h3>
              <label className="workspace-field"><span>Message</span><textarea rows={4} value={f.sms_body} onChange={(e) => set("sms_body", e.target.value)} maxLength={480} data-testid="mkt-sms" /></label>
              <p className="workspace-footnote">{prev?.sms_length ?? 0} characters. "Reply STOP to opt out." is added for you.</p>
            </section>
          )}
          <p className="workspace-footnote">Use {"{first}"} for their first name, {"{shop}"} for your shop name and {"{link}"} for your booking page.</p>
        </div>
        <aside className="mkt-side">
          <section className="workspace-panel mkt-preview">
            <h3>Preview</h3>
            {prev && (
              <>
                <div className="mkt-tiles">
                  <div><b>{prev.customers}</b><span>people</span></div>
                  <div><b>{prev.email}</b><span>emails</span></div>
                  <div><b>{prev.sms}</b><span>texts</span></div>
                  <div><b>{gbp(prev.cost_pence)}</b><span>text cost</span></div>
                </div>
                {(prev.held_back ?? 0) > 0 && <p className="workspace-footnote" data-testid="mkt-held-back">{plural(prev.held_back!, "customer")} left out because they opted out of marketing. They stay out until they switch it back on themselves.</p>}
                {prev.no_contact > 0 && <p className="workspace-footnote">{plural(prev.no_contact, "customer")} without a usable {f.channel === "SMS" ? "mobile number" : f.channel === "EMAIL" ? "email" : "mobile or email"} will be skipped.</p>}
                {f.channel !== "EMAIL" && <div className="mkt-sms"><span>{prev.sms_text}</span></div>}
                {prev.email_html && <iframe className="mkt-email" title="Email preview" srcDoc={prev.email_html} sandbox="" />}
              </>
            )}
          </section>
        </aside>
      </div>
      <div className="mkt-sendbar">
        <div className="mkt-sendcopy">
          {err && <p className="workspace-error" role="alert">{err}</p>}
          {!err && prev?.problems.map((p) => <p key={p} className="workspace-error" role="status">{p}</p>)}
          {note && <p className="workspace-success" role="status">{note}</p>}
          <label className="mkt-consent"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} data-testid="mkt-confirm" /><span>These are my own customers. Everyone can opt out: texts say STOP and emails have an unsubscribe link.</span></label>
          {needAck && <label className="mkt-consent"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="mkt-ack" /><span>Texts cost {info.sms_pence}p each and are added to your bill. This send is about {gbp(prev!.cost_pence)}.</span></label>}
        </div>
        <div className="mkt-sendbtns">
          {f.channel !== "SMS" && <Button variant="secondary" onClick={test} disabled={busy} data-testid="mkt-test">Send me a test</Button>}
          <Button onClick={send} disabled={busy || !ok || (needAck && !ack) || !prev || total === 0 || blocked || laterBad} data-testid="mkt-send">{when_ === "later" ? "Schedule" : "Send"} to {total}</Button>
        </div>
      </div>
    </div>
  );
}
