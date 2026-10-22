// "Tell your customers": the shop announces its new online booking page to its own customers.
// Branded as the shop (no foliyo), texts billed at 8p each, emails free.
import { useEffect, useRef, useState } from "react";
import { Button, Modal } from "./ui";

type Info = {
  campaigns: { id: string; name: string; channel: string; created_at: number; sms_count: number; email_count: number; sent: number; failed: number; waiting: number }[];
  defaults: { subject: string; heading: string; body: string; cta_label: string; sms_body: string };
  link: string; sms_on: boolean; email_on: boolean; sms_acked: boolean; sms_pence: number; sms_window_open: boolean; has_page: boolean;
};
type Prev = { customers: number; sms: number; email: number; landline: number; no_contact: number; sms_text: string; sms_length: number; email_subject: string; email_html: string | null; cost_pence: number; sms_window_open: boolean };

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(`/api/app${path}`, { method, credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string; message?: string }).error || (j as { message?: string }).message || "Something went wrong.");
  return j as T;
}
const gbp = (p: number) => `£${(p / 100).toFixed(2)}`;
const when = (t: number) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function ShopAnnounce({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [f, setF] = useState({ channel: "EMAIL" as "SMS" | "EMAIL" | "BOTH", audience: "ALL" as "ALL" | "OPTED_IN", subject: "", heading: "", body: "", sms_body: "", cta_label: "" });
  const [prev, setPrev] = useState<Prev | null>(null);
  const [err, setErr] = useState(""); const [note, setNote] = useState(""); const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false); const [ack, setAck] = useState(false); const [done, setDone] = useState<{ sms: number; email: number } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const load = () => call<Info>("/announcements").then((i) => { setInfo(i); setF((x) => (x.subject ? x : { ...x, subject: i.defaults.subject, heading: i.defaults.heading, body: i.defaults.body, sms_body: i.defaults.sms_body, cta_label: i.defaults.cta_label, channel: i.email_on ? "EMAIL" : "SMS" })); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!info || !f.subject) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { call<Prev>("/announcements/preview", "POST", f).then((p) => { setPrev(p); setErr(""); }).catch((e) => setErr(e.message)); }, 450);
    return () => window.clearTimeout(timer.current);
  }, [info, f]);

  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const needAck = !!prev && prev.sms > 0 && !info?.sms_acked;
  const total = prev ? new Set([prev.sms, prev.email]).size && Math.max(prev.sms, prev.email) : 0;

  async function test() {
    setBusy(true); setErr(""); setNote("");
    try { const r = await call<{ sent_to: string }>("/announcements/test", "POST", f); setNote(`Test email sent to ${r.sent_to}.`); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function send() {
    setBusy(true); setErr("");
    try { const r = await call<{ sms: number; email: number }>("/announcements/send", "POST", { ...f, confirm: true, sms_ack: ack || undefined }); setDone(r); load(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Modal title="Tell your customers" onClose={onClose} wide context="CUSTOMERS">
      <div className="sa" data-testid="shop-announce">
        {done ? (
          <div>
            <p className="workspace-success" role="status" data-testid="sa-done">Sent to your customers: {done.email} emails and {done.sms} texts queued. Emails go out now. {done.sms > 0 && !info?.sms_window_open ? "Texts wait for 09:00 (Monday to Saturday) and then go automatically." : ""}</p>
            <Button onClick={onClose}>Done</Button>
          </div>
        ) : !info ? <p>Loading...</p> : !info.has_page ? <p>Set your shop address in Settings first, so customers have a page to book on.</p> : (
          <div className="mk-grid">
            <div className="workspace-panel">
              <p className="workspace-footnote">Let your customers know you now take bookings online. It goes out as your shop, with your name, logo and colours, and replies come to you. Your customers' link: {info.link}</p>
              <fieldset className="mk-fieldset">
                <legend>Who gets it</legend>
                <label className="workspace-field"><span>Send by</span>
                  <select value={f.channel} onChange={(e) => set("channel", e.target.value as typeof f.channel)} data-testid="sa-channel">
                    {info.email_on && <option value="EMAIL">Email (free)</option>}
                    {info.sms_on && <option value="SMS">Text ({info.sms_pence}p each)</option>}
                    {info.email_on && info.sms_on && <option value="BOTH">Email and text</option>}
                  </select>
                </label>
                <label className="workspace-field"><span>Customers</span>
                  <select value={f.audience} onChange={(e) => set("audience", e.target.value as typeof f.audience)}>
                    <option value="ALL">All my customers</option>
                    <option value="OPTED_IN">Only those who agreed to hear from us</option>
                  </select>
                </label>
              </fieldset>
              {f.channel !== "SMS" && (
                <fieldset className="mk-fieldset">
                  <legend>Email</legend>
                  <label className="workspace-field"><span>Subject</span><input value={f.subject} onChange={(e) => set("subject", e.target.value)} maxLength={150} data-testid="sa-subject" /></label>
                  <label className="workspace-field"><span>Heading</span><input value={f.heading} onChange={(e) => set("heading", e.target.value)} maxLength={150} /></label>
                  <label className="workspace-field"><span>Message</span><textarea rows={6} value={f.body} onChange={(e) => set("body", e.target.value)} maxLength={3000} /></label>
                  <label className="workspace-field"><span>Button</span><input value={f.cta_label} onChange={(e) => set("cta_label", e.target.value)} maxLength={40} /></label>
                </fieldset>
              )}
              {f.channel !== "EMAIL" && (
                <fieldset className="mk-fieldset">
                  <legend>Text</legend>
                  <label className="workspace-field"><span>Message</span><textarea rows={4} value={f.sms_body} onChange={(e) => set("sms_body", e.target.value)} maxLength={480} data-testid="sa-sms" /></label>
                  <p className="workspace-footnote">{"{first}"} is their first name, {"{shop}"} your shop name, {"{link}"} your booking page. "Reply STOP to opt out." is added automatically.</p>
                </fieldset>
              )}
            </div>
            <div className="workspace-panel">
              <h3>Before you send</h3>
              {prev && (
                <>
                  <div className="mk-tiles small">
                    <div><b>{prev.customers}</b><span>customers</span></div>
                    <div><b>{prev.email}</b><span>emails</span></div>
                    <div><b>{prev.sms}</b><span>texts</span></div>
                    <div><b>{gbp(prev.cost_pence)}</b><span>text cost</span></div>
                  </div>
                  {prev.no_contact > 0 && <p className="workspace-footnote">{prev.no_contact} customers have no usable {f.channel === "SMS" ? "mobile number" : f.channel === "EMAIL" ? "email" : "mobile or email"} and are skipped. {prev.landline > 0 ? `${prev.landline} have only a landline.` : ""}</p>}
                  {prev.sms > 0 && !prev.sms_window_open && <p className="workspace-footnote">Texts only go out 09:00 to 20:00, Monday to Saturday. These will wait until then.</p>}
                  {f.channel !== "EMAIL" && <div className="mk-sms-preview"><span>{prev.sms_text}</span></div>}
                  {prev.email_html && <iframe className="mk-email-preview" title="Email preview" srcDoc={prev.email_html} sandbox="" />}
                </>
              )}
              {err && <p className="workspace-error" role="alert">{err}</p>}
              {note && <p className="workspace-success" role="status">{note}</p>}
              {f.channel !== "SMS" && <Button variant="secondary" onClick={test} disabled={busy} data-testid="sa-test">Send me a test email</Button>}
              <div className="mk-send">
                <label className="mk-consent"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} data-testid="sa-confirm" /><span>These are my own customers. Everyone can opt out: texts say STOP and emails have an unsubscribe link.</span></label>
                {needAck && <label className="mk-consent"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="sa-ack" /><span>Texts cost {info.sms_pence}p each and are added to your bill. This one send will cost about {gbp(prev!.cost_pence)}.</span></label>}
                <Button onClick={send} disabled={busy || !ok || (needAck && !ack) || !prev || total === 0} data-testid="sa-send">Send to {total} customers</Button>
              </div>
            </div>
            {info.campaigns.length > 0 && (
              <div className="workspace-panel" style={{ gridColumn: "1 / -1" }}>
                <h3>Sent before</h3>
                <ul className="mk-list">{info.campaigns.map((c) => <li key={c.id}><b>{c.name}</b> <small>{when(c.created_at)} · {c.sent} sent · {c.waiting} waiting · {c.failed} failed</small></li>)}</ul>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
