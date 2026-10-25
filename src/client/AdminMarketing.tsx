// Marketing: upload a CSV, let the engine pull out every mobile number and email, then text and email
// the list about foliyo. Super admins only. Unsubscribes and STOP replies are honoured automatically.
import { useEffect, useRef, useState } from "react";
import { adminApi } from "./Admin";
import { Button, Icon } from "./ui";

type Stats = { contacts: number; with_mobile: number; with_email: number; with_both: number; landline_only: number; email_only: number; no_contact_details: number; duplicates_merged: number; bad_numbers: number; bad_emails: number };
type Preview = { rows_read: number; stats: Stats; contacts: { name: string; business: string; phone: string; landline: string; email: string; notes: string[] }[]; contacts_total: number; problems: { row: number; text: string; why: string }[]; already_in_system: number; unsubscribed: number; headers: string[] | null };
type Campaign = { id: string; name: string; channel: "SMS" | "EMAIL" | "BOTH"; list_name: string; subject: string; heading: string; body: string; sms_body: string; cta_label: string; cta_url: string; why: string; status: string; selected?: number; recipients: number; sent: number; failed: number; queued: number; created_at: number };
type Overview = { totals: { contacts: number; mobiles: number; emails: number; unsubscribed: number }; lists: { name: string; contacts: number }[]; campaigns: Campaign[]; defaults: Record<string, string>; sms_window_open: boolean };
type Audience = { sms: number; email: number; contacts: number; sms_text: string; sms_length: number; email_html: string | null; email_subject: string | null; sms_window_open: boolean };

type Person = { id: string; list_name: string; name: string; business: string; phone: string; email: string; landline: string; unsubscribed_at: number | null; unsub_reason: string };

const n = (v: number) => v.toLocaleString("en-GB");
const smsParts = (len: number) => (len <= 160 ? 1 : Math.ceil(len / 153));

export function AdminMarketing({ me }: { me: { role: string } }) {
  const [tab, setTab] = useState<"contacts" | "campaigns">("contacts");
  const [ov, setOv] = useState<Overview | null>(null);
  const [err, setErr] = useState("");
  // People ticked in the contacts table. Carried into a new campaign so "pick people, then message them" is one flow.
  const [picked, setPicked] = useState<string[]>([]);
  const [startNew, setStartNew] = useState(false);
  const load = () => adminApi<Overview>("/marketing/overview").then(setOv).catch((e) => setErr(e instanceof Error ? e.message : "Could not load"));
  useEffect(() => { void load(); }, []);
  if (me.role !== "SUPER") return <section className="admin-section"><h1>Marketing</h1><p className="workspace-footnote">Only super admins can use marketing.</p></section>;
  return (
    <section className="admin-section" data-testid="admin-marketing">
      <h1>Marketing <small>texts and emails about foliyo</small></h1>
      {err && <p className="workspace-error" role="alert">{err}</p>}
      {ov && (
        <div className="mk-tiles">
          <div><b>{n(ov.totals.contacts)}</b><span>contacts</span></div>
          <div><b>{n(ov.totals.mobiles)}</b><span>can be texted</span></div>
          <div><b>{n(ov.totals.emails)}</b><span>can be emailed</span></div>
          <div><b>{n(ov.totals.unsubscribed)}</b><span>opted out</span></div>
        </div>
      )}
      <div className="segmented mk-tabs" role="tablist">
        <button type="button" role="tab" aria-pressed={tab === "contacts"} onClick={() => setTab("contacts")} data-testid="mk-tab-contacts">Contacts</button>
        <button type="button" role="tab" aria-pressed={tab === "campaigns"} onClick={() => setTab("campaigns")} data-testid="mk-tab-campaigns">Campaigns</button>
      </div>
      {ov && tab === "contacts" && <Contacts ov={ov} reload={load} picked={picked} setPicked={setPicked} onStart={() => { setStartNew(true); setTab("campaigns"); }} />}
      {ov && tab === "campaigns" && <Campaigns ov={ov} reload={load} picked={picked} setPicked={setPicked} startNew={startNew} clearStart={() => setStartNew(false)} />}
    </section>
  );
}

function Contacts({ ov, reload, picked, setPicked, onStart }: { ov: Overview; reload: () => Promise<unknown>; picked: string[]; setPicked: (v: string[]) => void; onStart: () => void }) {
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [pv, setPv] = useState<Preview | null>(null);
  const [list, setList] = useState("");
  const [basis, setBasis] = useState("Business contacts listed publicly as barbers or hair businesses");
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function read(file: File | undefined) {
    if (!file) return;
    setErr(""); setMsg(""); setPv(null); setBusy(true);
    try {
      const text = await file.text();
      setCsv(text); setFileName(file.name);
      setList(file.name.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").slice(0, 60));
      setPv(await adminApi<Preview>("/marketing/preview", "POST", { csv: text }));
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not read that file"); } finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setErr("");
    try {
      const r = await adminApi<{ created: number; updated: number; skipped: number }>("/marketing/import", "POST", { csv, list_name: list, basis, confirm: ok });
      setMsg(`Added ${n(r.created)} new contacts${r.updated ? `, updated ${n(r.updated)} that we already had` : ""}${r.skipped ? `, skipped ${n(r.skipped)}` : ""}.`);
      setPv(null); setCsv(""); setFileName(""); setOk(false);
      await reload();
    } catch (e) { setErr(e instanceof Error ? e.message : "Import failed"); } finally { setBusy(false); }
  }
  return (
    <div className="mk-grid">
      <div className="workspace-panel">
        <h3>Upload a list</h3>
        <p className="workspace-footnote" data-testid="mk-apart-note"><b>Marketing only.</b> People in these lists are not customers or accounts. They never appear in any shop, and the only thing that happens to them is the message you choose to send.</p>
        <p className="workspace-footnote">Any CSV works: with or without headings, in any column order. The engine finds mobile numbers in every spelling, email addresses, names and business names, removes duplicates, and tells you what it could not use.</p>
        <div
          className={`mk-drop${drag ? " over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); void read(e.dataTransfer.files[0]); }}
          onClick={() => input.current?.click()}
          role="button" tabIndex={0}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
          data-testid="mk-drop"
        >
          <Icon name="upload" size={22} />
          <strong>{fileName || "Drop a CSV here, or tap to choose"}</strong>
          <small>.csv, .tsv or .txt, up to 6 MB</small>
          <input ref={input} type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" hidden onChange={(e) => void read(e.target.files?.[0])} data-testid="mk-file" />
        </div>
        {busy && !pv && <p className="workspace-footnote">Reading the file…</p>}
        {err && <p className="workspace-error" role="alert">{err}</p>}
        {msg && <p className="workspace-ok" role="status">{msg}</p>}
        {pv && (
          <div data-testid="mk-preview">
            <div className="mk-tiles small">
              <div><b>{n(pv.stats.contacts)}</b><span>people found</span></div>
              <div><b>{n(pv.stats.with_mobile)}</b><span>mobiles</span></div>
              <div><b>{n(pv.stats.with_email)}</b><span>emails</span></div>
              <div><b>{n(pv.stats.duplicates_merged)}</b><span>duplicates merged</span></div>
            </div>
            <p className="workspace-footnote">
              Read {n(pv.rows_read)} rows. {n(pv.stats.landline_only)} had only a landline (cannot be texted), {n(pv.stats.no_contact_details)} had no usable details
              {pv.already_in_system ? `, ${n(pv.already_in_system)} are already in the system${pv.unsubscribed ? ` (${n(pv.unsubscribed)} of them opted out and stay opted out)` : ""}` : ""}.
            </p>
            <div className="mk-table-wrap">
              <table className="mk-table">
                <thead><tr><th>Name</th><th>Business</th><th>Mobile</th><th>Email</th></tr></thead>
                <tbody>
                  {pv.contacts.slice(0, 12).map((c, i) => (
                    <tr key={i}><td>{c.name || "–"}</td><td>{c.business || "–"}</td><td>{c.phone || (c.landline ? `${c.landline} (landline)` : "–")}</td><td>{c.email || "–"}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pv.contacts_total > 12 && <p className="workspace-footnote">Showing 12 of {n(pv.contacts_total)}.</p>}
            {pv.problems.length > 0 && (
              <details className="mk-problems"><summary>{pv.problems.length} row{pv.problems.length === 1 ? "" : "s"} could not be used</summary>
                <ul>{pv.problems.map((p, i) => <li key={i}><b>Row {p.row}:</b> {p.why}</li>)}</ul>
              </details>
            )}
            <label className="workspace-field"><span>List name</span><input value={list} onChange={(e) => setList(e.target.value)} maxLength={80} data-testid="mk-list-name" /></label>
            <label className="workspace-field"><span>Why can we contact them? (kept on record)</span><input value={basis} onChange={(e) => setBasis(e.target.value)} maxLength={200} /></label>
            <label className="mk-consent"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} data-testid="mk-import-confirm" /><span>I confirm these are business contacts we may lawfully contact about foliyo, or people who asked to hear from us.</span></label>
            <Button onClick={save} disabled={busy || !ok || !list.trim() || pv.stats.contacts === 0} data-testid="mk-import">Add {n(pv.stats.contacts)} contacts to the list</Button>
          </div>
        )}
      </div>
      <div className="workspace-panel">
        <h3>Your lists</h3>
        {ov.lists.length === 0 && <p className="workspace-footnote">No lists yet. Upload a CSV to start.</p>}
        <ul className="mk-lists">
          {ov.lists.map((l) => (
            <li key={l.name}>
              <span><strong>{l.name || "Unnamed"}</strong><small>{n(l.contacts)} contacts</small></span>
              <Button variant="ghost" onClick={async () => { if (confirm(`Remove "${l.name}" and its contacts? Anyone who opted out stays on the do-not-contact list.`)) { await adminApi(`/marketing/lists/${encodeURIComponent(l.name)}`, "DELETE"); await reload(); } }}>Remove</Button>
            </li>
          ))}
        </ul>
        <p className="workspace-footnote">People who unsubscribe or reply STOP are never contacted again, even if they appear in a later upload.</p>
      </div>
      <ContactTable ov={ov} reload={reload} picked={picked} setPicked={setPicked} onStart={onStart} />
    </div>
  );
}

const PAGE = 50;
function ContactTable({ ov, reload, picked, setPicked, onStart }: { ov: Overview; reload: () => Promise<unknown>; picked: string[]; setPicked: (v: string[]) => void; onStart: () => void }) {
  const [q, setQ] = useState("");
  const [list, setList] = useState("");
  const [has, setHas] = useState("");
  const [status, setStatus] = useState("active");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<Person[]>([]);
  const [total, setTotal] = useState(0);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const chosen = new Set(picked);
  const qs = (extra: string) => `/marketing/contacts?q=${encodeURIComponent(q.trim())}&list=${encodeURIComponent(list)}&has=${has}&status=${status}${extra}`;

  useEffect(() => {
    const t = setTimeout(() => {
      setBusy(true); setErr("");
      adminApi<{ contacts: Person[]; total: number; active: number }>(qs(`&limit=${PAGE}&offset=${page * PAGE}`))
        .then((r) => { setRows(r.contacts); setTotal(r.total); setActive(r.active); })
        .catch((e) => setErr(e instanceof Error ? e.message : "Could not load contacts"))
        .finally(() => setBusy(false));
    }, 200);
    return () => clearTimeout(t);
  }, [q, list, has, status, page, ov.totals.contacts]);
  useEffect(() => { setPage(0); }, [q, list, has, status]);

  const pageIds = rows.filter((r) => !r.unsubscribed_at).map((r) => r.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => chosen.has(id));
  const toggle = (id: string) => setPicked(chosen.has(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  const togglePage = () => setPicked(allOnPage ? picked.filter((id) => !pageIds.includes(id)) : [...new Set([...picked, ...pageIds])]);
  async function selectAll() {
    setBusy(true); setErr("");
    try { const r = await adminApi<{ ids: string[] }>(qs("&ids=1")); setPicked([...new Set([...picked, ...r.ids])]); }
    catch (e) { setErr(e instanceof Error ? e.message : "Could not select everyone"); } finally { setBusy(false); }
  }
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div className="workspace-panel mk-all" data-testid="mk-contacts-panel">
      <div className="mk-head"><h3>All contacts <small>{n(ov.totals.contacts)} in total</small></h3></div>
      <div className="mk-filters">
        <input type="search" placeholder="Search name, business, number or email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search contacts" data-testid="mk-search" />
        <select value={list} onChange={(e) => setList(e.target.value)} aria-label="List" data-testid="mk-filter-list">
          <option value="">All lists</option>
          {ov.lists.map((l) => <option key={l.name} value={l.name}>{l.name || "Unnamed"} ({n(l.contacts)})</option>)}
        </select>
        <select value={has} onChange={(e) => setHas(e.target.value)} aria-label="Has" data-testid="mk-filter-has">
          <option value="">Mobile or email</option>
          <option value="mobile">Has a mobile</option>
          <option value="email">Has an email</option>
          <option value="both">Has both</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" data-testid="mk-filter-status">
          <option value="active">Can be contacted</option>
          <option value="optout">Opted out</option>
          <option value="">Everyone</option>
        </select>
      </div>
      {err && <p className="workspace-error" role="alert">{err}</p>}
      <div className="mk-selbar" data-testid="mk-selbar">
        <span><b data-testid="mk-picked-count">{n(picked.length)}</b> selected</span>
        {total > 0 && active > pageIds.length && <Button variant="ghost" onClick={selectAll} disabled={busy} data-testid="mk-select-all">Select all {n(active)} who match</Button>}
        {picked.length > 0 && <Button variant="ghost" onClick={() => setPicked([])} data-testid="mk-clear">Clear</Button>}
        <Button onClick={onStart} disabled={picked.length === 0} data-testid="mk-start-campaign">Message {n(picked.length)} {picked.length === 1 ? "person" : "people"}</Button>
      </div>
      <div className="mk-table-wrap">
        <table className="mk-table" data-testid="mk-contacts-table">
          <thead><tr>
            <th><input type="checkbox" checked={allOnPage} onChange={togglePage} disabled={pageIds.length === 0} aria-label="Select everyone on this page" data-testid="mk-select-page" /></th>
            <th>Name</th><th>Business</th><th>Mobile</th><th>Email</th><th>List</th><th></th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.unsubscribed_at ? "mk-optout" : ""}>
                <td><input type="checkbox" checked={chosen.has(r.id)} onChange={() => toggle(r.id)} disabled={!!r.unsubscribed_at} aria-label={`Select ${r.name || r.email || r.phone}`} data-testid="mk-row-check" /></td>
                <td>{r.name || "–"}</td><td>{r.business || "–"}</td>
                <td>{r.phone || (r.landline ? `${r.landline} (landline)` : "–")}</td><td>{r.email || "–"}</td>
                <td>{r.list_name || "–"}</td>
                <td>{r.unsubscribed_at ? <span className="admin-flag">opted out</span> : <Button variant="ghost" onClick={async () => { if (confirm(`Stop contacting ${r.name || r.email || r.phone}? This cannot be undone here.`)) { await adminApi(`/marketing/contacts/${r.id}/unsubscribe`, "POST"); setPicked(picked.filter((x) => x !== r.id)); await reload(); } }}>Opt out</Button>}</td>
              </tr>
            ))}
            {rows.length === 0 && !busy && <tr><td colSpan={7} className="workspace-footnote">{ov.totals.contacts === 0 ? "No contacts yet. Upload a CSV above." : "Nobody matches that search."}</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="mk-pager">
        <span className="workspace-footnote">{total === 0 ? "0 people" : `${n(page * PAGE + 1)}–${n(Math.min(total, (page + 1) * PAGE))} of ${n(total)}`}</span>
        <Button variant="ghost" onClick={() => setPage(page - 1)} disabled={page === 0 || busy} data-testid="mk-prev">Previous</Button>
        <Button variant="ghost" onClick={() => setPage(page + 1)} disabled={page + 1 >= pages || busy} data-testid="mk-next">Next</Button>
      </div>
    </div>
  );
}

function Campaigns({ ov, reload, picked, setPicked, startNew, clearStart }: { ov: Overview; reload: () => Promise<unknown>; picked: string[]; setPicked: (v: string[]) => void; startNew: boolean; clearStart: () => void }) {
  const [open, setOpen] = useState<string | "new" | null>(startNew ? "new" : null);
  useEffect(() => { if (startNew) clearStart(); }, []);
  return (
    <div>
      {open === null && (
        <>
          <div className="mk-head"><h3>Campaigns</h3><Button onClick={() => setOpen("new")} data-testid="mk-new-campaign"><Icon name="plus" size={14} /> New campaign</Button></div>
          {ov.campaigns.length === 0 && <p className="workspace-footnote">No campaigns yet. Create one to text and email a list about foliyo.</p>}
          <ul className="mk-campaigns">
            {ov.campaigns.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => setOpen(c.id)}>
                  <span><strong>{c.name}</strong><small>{c.selected ? `${n(c.selected)} hand-picked` : c.list_name || "All lists"} · {c.channel === "BOTH" ? "Text and email" : c.channel === "SMS" ? "Text" : "Email"}</small></span>
                  <span className={`mk-status ${c.status.toLowerCase()}`}>{c.status === "DRAFT" ? "Draft" : c.status === "SENDING" ? `Sending · ${n(c.queued)} left` : c.status === "PAUSED" ? "Paused" : "Done"}</span>
                  {c.status !== "DRAFT" && <small>{n(c.sent)} sent{c.failed ? ` · ${n(c.failed)} failed` : ""}</small>}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {open !== null && <Composer ov={ov} id={open === "new" ? null : open} initialPicked={open === "new" ? picked : []} onClose={async (done) => { if (done) setPicked([]); setOpen(null); await reload(); }} />}
    </div>
  );
}

function Composer({ ov, id, initialPicked, onClose }: { ov: Overview; id: string | null; initialPicked: string[]; onClose: (done?: boolean) => void }) {
  const D = ov.defaults;
  const existing = id ? ov.campaigns.find((c) => c.id === id) : null;
  const [f, setF] = useState({
    name: existing?.name ?? "", channel: (existing?.channel ?? "BOTH") as "SMS" | "EMAIL" | "BOTH", list_name: existing?.list_name ?? ov.lists[0]?.name ?? "",
    subject: existing?.subject ?? D.subject, heading: existing?.heading ?? D.heading, body: existing?.body ?? D.body, sms_body: existing?.sms_body ?? D.sms_body,
    cta_label: existing?.cta_label ?? D.cta_label, cta_url: existing?.cta_url ?? `${location.origin}/signup`, why: existing?.why ?? D.why,
  });
  const [cid, setCid] = useState<string | null>(id);
  // Hand-picked people for this campaign. Empty means "the whole list chosen above".
  const [sel, setSel] = useState<string[]>(initialPicked);
  useEffect(() => { if (id) adminApi<{ ids: string[] }>(`/marketing/campaigns/${id}/contacts`).then((r) => setSel(r.ids)).catch(() => {}); }, []);
  const [aud, setAud] = useState<Audience | null>(null);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const [word, setWord] = useState("");
  const [testEmail, setTestEmail] = useState("");
  const [testPhone, setTestPhone] = useState("");
  const [pence, setPence] = useState(5);
  const locked = !!existing && existing.status !== "DRAFT";
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));

  async function save(): Promise<string | null> {
    setErr(""); setBusy(true);
    try {
      let k = cid;
      if (k) await adminApi(`/marketing/campaigns/${k}`, "PUT", f);
      else { const r = await adminApi<{ id: string }>("/marketing/campaigns", "POST", f); k = r.id; setCid(k); }
      if (!locked) await adminApi(`/marketing/campaigns/${k}/contacts`, "PUT", { contact_ids: sel });
      return k;
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not save"); return null; } finally { setBusy(false); }
  }
  async function review() {
    const k = locked ? cid : await save();
    if (!k) return;
    try { setAud(await adminApi<Audience>(`/marketing/campaigns/${k}/audience`)); } catch (e) { setErr(e instanceof Error ? e.message : "Could not check the audience"); }
  }
  useEffect(() => { if (locked && cid) void review(); }, []);
  async function test() {
    const k = await save(); if (!k) return;
    setBusy(true); setNote("");
    try { const r = await adminApi<Record<string, string>>(`/marketing/campaigns/${k}/test`, "POST", { email: testEmail || undefined, phone: testPhone || undefined }); setNote(Object.entries(r).map(([a, b]) => `${a === "sms" ? "Text" : "Email"}: ${b}`).join(" · ")); }
    catch (e) { setErr(e instanceof Error ? e.message : "Test failed"); } finally { setBusy(false); }
  }
  async function send() {
    setBusy(true); setErr("");
    try {
      const r = await adminApi<{ queued: { sms: number; email: number } }>(`/marketing/campaigns/${cid}/send`, "POST", { confirm: ok });
      setNote(`Started. ${n(r.queued.email)} emails and ${n(r.queued.sms)} texts are going out. Texts only send 09:00 to 20:00 UK time, Monday to Saturday.`);
      onClose(true);
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not send"); } finally { setBusy(false); }
  }
  const smsLen = (f.sms_body.replace(/\{link\}/g, f.cta_url || "https://foliyo.co.uk/signup").replace(/\{first\}/g, "Sam").length) + (/stop/i.test(f.sms_body) ? 0 : 23);

  return (
    <div className="mk-composer">
      <div className="mk-head"><Button variant="ghost" onClick={() => onClose()}><Icon name="left" size={14} /> All campaigns</Button>
        {existing && existing.status !== "DRAFT" && <span className={`mk-status ${existing.status.toLowerCase()}`}>{existing.status.toLowerCase()}</span>}</div>
      <div className="mk-grid">
        <div className="workspace-panel">
          <fieldset disabled={locked} className="mk-fields">
            <label className="workspace-field"><span>Campaign name</span><input value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Kent barbers, October" data-testid="mk-name" /></label>
            <div className="workspace-form-grid two">
              <label className="workspace-field"><span>Send to</span>
                {sel.length > 0 ? (
                  <span className="mk-picked" data-testid="mk-picked-note"><b>{n(sel.length)} hand-picked {sel.length === 1 ? "person" : "people"}</b>
                    {!locked && <Button variant="ghost" onClick={() => setSel([])} data-testid="mk-use-list">Use a whole list instead</Button>}</span>
                ) : (
                <select value={f.list_name} onChange={(e) => set("list_name", e.target.value)} data-testid="mk-list">
                  <option value="">All lists</option>
                  {ov.lists.map((l) => <option key={l.name} value={l.name}>{l.name} ({n(l.contacts)})</option>)}
                </select>
                )}</label>
              <div className="workspace-field"><span>How</span>
                <div className="segmented" role="group" aria-label="Channel">
                  {(["SMS", "EMAIL", "BOTH"] as const).map((c) => <button type="button" key={c} aria-pressed={f.channel === c} onClick={() => set("channel", c)} data-testid={`mk-channel-${c}`}>{c === "SMS" ? "Text" : c === "EMAIL" ? "Email" : "Both"}</button>)}
                </div></div>
            </div>
            {f.channel !== "SMS" && (
              <>
                <h4>Email</h4>
                <label className="workspace-field"><span>Subject</span><input value={f.subject} onChange={(e) => set("subject", e.target.value)} maxLength={150} /></label>
                <label className="workspace-field"><span>Headline</span><input value={f.heading} onChange={(e) => set("heading", e.target.value)} maxLength={150} /></label>
                <label className="workspace-field"><span>Message</span><textarea rows={8} value={f.body} onChange={(e) => set("body", e.target.value)} maxLength={4000} /></label>
                <div className="workspace-form-grid two">
                  <label className="workspace-field"><span>Button label</span><input value={f.cta_label} onChange={(e) => set("cta_label", e.target.value)} maxLength={40} /></label>
                  <label className="workspace-field"><span>Sign-up link</span><input value={f.cta_url} onChange={(e) => set("cta_url", e.target.value)} placeholder="https://foliyo.co.uk/signup" /></label>
                </div>
                <label className="workspace-field"><span>Why they are getting it (shown in the footer)</span><textarea rows={2} value={f.why} onChange={(e) => set("why", e.target.value)} maxLength={400} /></label>
              </>
            )}
            {f.channel !== "EMAIL" && (
              <>
                <h4>Text</h4>
                <label className="workspace-field"><span>Message</span><textarea rows={4} value={f.sms_body} onChange={(e) => set("sms_body", e.target.value)} maxLength={600} data-testid="mk-sms" /></label>
                <p className="workspace-footnote">{smsLen} characters, {smsParts(smsLen)} text{smsParts(smsLen) === 1 ? "" : "s"} each. "Reply STOP to opt out." is added automatically.</p>
              </>
            )}
            <p className="workspace-footnote">Merge fields: {"{first}"} first name, {"{business}"} business name, {"{link}"} sign-up link.</p>
          </fieldset>
          {err && <p className="workspace-error" role="alert">{err}</p>}
          {note && <p className="workspace-ok" role="status">{note}</p>}
          {!locked && <Button onClick={review} disabled={busy || !f.name.trim()} data-testid="mk-review">Save and review</Button>}
        </div>
        <div className="workspace-panel" data-testid="mk-review-panel">
          <h3>Before you send</h3>
          {!aud && <p className="workspace-footnote">Save the campaign to see who would get it, a preview, and send a test to yourself.</p>}
          {aud && (
            <>
              <div className="mk-tiles small">
                <div><b>{n(aud.contacts)}</b><span>people</span></div>
                <div><b>{n(aud.email)}</b><span>emails</span></div>
                <div><b>{n(aud.sms)}</b><span>texts</span></div>
                <div><b>£{((aud.sms * smsParts(smsLen) * pence) / 100).toFixed(2)}</b><span>text cost</span></div>
              </div>
              <label className="workspace-field inline"><span>Your cost per text (pence)</span><input type="number" min={1} max={20} value={pence} onChange={(e) => setPence(Number(e.target.value) || 5)} style={{ width: 80 }} /></label>
              <p className="workspace-footnote">Text cost is an estimate. Check your provider's real rate. Emails are free to send.</p>
              {aud.sms > 0 && !aud.sms_window_open && <p className="workspace-footnote">Texts are paused right now (outside 09:00 to 20:00 UK, Monday to Saturday). They go out automatically when the window opens.</p>}
              {aud.sms_text && f.channel !== "EMAIL" && <div className="mk-sms-preview"><span>{aud.sms_text}</span></div>}
              {aud.email_html && f.channel !== "SMS" && <iframe className="mk-email-preview" title="Email preview" srcDoc={aud.email_html} sandbox="" />}
              <h4>Send yourself a test</h4>
              <div className="workspace-form-grid two">
                <label className="workspace-field"><span>Email</span><input type="email" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} data-testid="mk-test-email" /></label>
                <label className="workspace-field"><span>Mobile</span><input type="tel" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} data-testid="mk-test-phone" /></label>
              </div>
              <Button variant="secondary" onClick={test} disabled={busy || (!testEmail && !testPhone)} data-testid="mk-test">Send test</Button>
              {!locked && (
                <div className="mk-send">
                  <label className="mk-consent"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} data-testid="mk-send-confirm" /><span>I confirm these contacts can lawfully be contacted about foliyo, and that the message says who we are and how to opt out.</span></label>
                  <label className="workspace-field"><span>Type SEND to start</span><input value={word} onChange={(e) => setWord(e.target.value)} autoComplete="off" data-testid="mk-send-word" /></label>
                  <Button onClick={send} disabled={busy || !ok || word.trim().toUpperCase() !== "SEND" || aud.contacts === 0} data-testid="mk-send">Send to {n(aud.contacts)} people</Button>
                </div>
              )}
              {locked && existing && (
                <div className="mk-send">
                  <p className="workspace-footnote">{n(existing.sent)} sent · {n(existing.failed)} failed · {n(existing.queued)} waiting.</p>
                  {existing.status === "SENDING" && <Button variant="secondary" onClick={async () => { await adminApi(`/marketing/campaigns/${existing.id}/pause`, "POST"); onClose(); }}>Pause</Button>}
                  {existing.status === "PAUSED" && <Button variant="secondary" onClick={async () => { await adminApi(`/marketing/campaigns/${existing.id}/resume`, "POST"); onClose(); }}>Resume</Button>}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
