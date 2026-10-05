// Setup wizard steps 4–7. See Setup.tsx for the frame and steps 1–3.
import { useEffect, useRef, useState } from "react";
import type { Staff } from "../server/domain";
import { Badge, Button, Icon } from "./ui";
import { money } from "./fixtures";
import { F, StepActions, useBusy, useSetupDirty, type StepProps } from "./Setup";
import { SmsBillingAck, SmsSenderField, suggestSenders } from "./SmsSender";

type Invite = { id: string; staff_id: string; email: string; phone: string; role: string; channel: string; sent_count: number; last_sent_at: number | null; expires_at: number; accepted_at: number | null; revoked: number };
type Member = { id: string; name: string; email: string; staff_id: string | null; role: string; active: number };
type Access = { members: Member[]; invitations: Invite[]; providers: { email: { provider: string }; sms: { provider: string } } };
const ROLE_LABEL: Record<string, string> = { BARBER: "Barber", RECEPTION: "Reception", MANAGER: "Manager" };
const ROLE_HINT: Record<string, string> = { BARBER: "Their own calendar, customers and pay. Can't change settings.", RECEPTION: "Everyone's calendar and the till. No pay or settings.", MANAGER: "Everything except billing and ownership." };

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

// ---- 4. Team --------------------------------------------------------------------------------------
export function StepTeam({ w, api, refresh, setNotice, setError, goTo, onNext, onSkip }: StepProps) {
  const [access, setAccess] = useState<Access | null>(null);
  const [adding, setAdding] = useState({ name: "", role: "Barber" });
  const [inviting, setInviting] = useState<string | null>(null); // staff id
  const [inv, setInv] = useState({ email: "", phone: "", role: "BARBER", channel: "EMAIL" as "EMAIL" | "SMS" | "BOTH" | "LINK" });
  useSetupDirty(!!adding.name.trim() || !!inviting);
  const [accessError, setAccessError] = useState("");
  const [link, setLink] = useState<{ staff: string; url: string; sent: string[] } | null>(null);
  const { busy, run } = useBusy();
  const isOwner = w.account?.role === "OWNER";
  const loadAccess = () => { setAccessError(""); return api<Access>("/auth/access").then(setAccess).catch(e => setAccessError(e.message || "Could not load team access.")); };
  useEffect(() => { loadAccess(); }, []);
  const team = w.staff.filter((s) => s.active);
  const memberFor = (s: Staff) => access?.members.find((m) => m.staff_id === s.id);
  const pendingFor = (s: Staff) => access?.invitations.find((i) => i.staff_id === s.id && !i.accepted_at && !i.revoked && i.expires_at > Date.now());
  const me = access?.members.find((m) => m.role === "OWNER");
  async function addBarber() {
    if (adding.name.trim().length < 2) return;
    await api("/staff", "POST", { name: adding.name.trim(), role: adding.role || "Barber" });
    setAdding({ name: "", role: "Barber" });
    setNotice(`${adding.name.trim()} added with the shop's hours.`);
    await refresh();
  }
  async function sendInvite(s: Staff) {
    const r = await api<{ link: string; sent: string[]; delivery: string }>("/auth/invites", "POST", { staff_id: s.id, email: inv.email, phone: inv.phone, role: inv.role, channel: inv.channel });
    setLink({ staff: s.id, url: r.link, sent: r.sent });
    setInviting(null);
    setInv({ email: "", phone: "", role: "BARBER", channel: "EMAIL" });
    setNotice(r.sent.length ? `Invitation sent to ${s.name} by ${r.sent.join(" and ")}.` : `Invitation created for ${s.name} — share the link below.`);
    await loadAccess();
  }
  async function resend(i: Invite, channel?: string) {
    const r = await api<{ link: string; sent: string[] }>(`/auth/invites/${i.id}/resend`, "POST", channel ? { channel } : {});
    setLink({ staff: i.staff_id, url: r.link, sent: r.sent });
    setNotice(r.sent.length ? `Sent again by ${r.sent.join(" and ")}.` : "New link ready to share.");
    await loadAccess();
  }
  const canSms = !!access && access.providers.sms.provider !== "mailbox";
  const canEmail = !!access && access.providers.email.provider !== "mailbox";
  return (
    <div className="setup-wiz-card">
      <p className="setup-wiz-lead">Add everyone who takes bookings. Invite them when you're ready. Barbers see their own column; reception and manager access depend on the role you choose.</p>
      {accessError && <p role="alert">{accessError} <Button variant="secondary" onClick={loadAccess}>Retry team access</Button></p>}
      <ul className="setup-team" data-testid="setup-team-list">
        {team.map((s) => {
          const m = memberFor(s), p = pendingFor(s);
          const isMe = me && (s.role === "Owner" || s.title === "Owner & barber") && !m;
          return (
            <li key={s.id}>
              <div className="setup-team-who">
                <strong>{s.name}</strong>
                <span>{s.title || s.role}</span>
              </div>
              <div className="setup-team-state">
                {isMe ? <Badge>You</Badge>
                  : m ? <Badge tone="good">Joined · {ROLE_LABEL[m.role] || m.role}</Badge>
                  : p ? (
                    <>
                      <Badge tone="next">Invited {p.channel === "LINK" ? "by link" : `by ${p.channel.toLowerCase()}`}{p.sent_count > 1 ? ` ×${p.sent_count}` : ""}</Badge>
                      <button type="button" className="linklike" disabled={busy} onClick={() => run(() => resend(p), setError)}>Resend</button>
                      {canSms && p.phone && p.channel !== "SMS" && <button type="button" className="linklike" disabled={busy} onClick={() => run(() => resend(p, "SMS"), setError)}>Text instead</button>}
                      <button type="button" className="linklike" disabled={busy} onClick={() => run(async () => { await api(`/auth/invites/${p.id}/revoke`, "POST", {}); setNotice("Invitation withdrawn."); await loadAccess(); }, setError)}>Withdraw</button>
                    </>
                  ) : (
                    <Button variant="secondary" disabled={!access || busy} onClick={() => { setInviting(s.id); setInv({ email: "", phone: "", role: "BARBER", channel: canEmail ? "EMAIL" : canSms ? "SMS" : "LINK" }); setLink(null); }} data-testid={`invite-${s.id}`}>Invite</Button>
                  )}
              </div>
              {inviting === s.id && (
                <form className="setup-invite" onSubmit={(e) => { e.preventDefault(); run(() => sendInvite(s), setError); }} data-testid="invite-form">
                  <p className="helper">Add an email or mobile to identify this person. Choosing a link creates the invitation without sending a message.</p>
                  <div className="setup-grid-2">
                    <F label="Email"><input type="email" inputMode="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} placeholder="them@example.com" data-testid="invite-email" /></F>
                    <F label="Mobile"><input type="tel" inputMode="tel" value={inv.phone} onChange={(e) => setInv({ ...inv, phone: e.target.value })} placeholder="07700 900123" data-testid="invite-phone" /></F>
                    <F label="Role" hint={ROLE_HINT[inv.role]}>
                      <select value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value })}>
                        <option value="BARBER">Barber</option><option value="RECEPTION">Reception</option>{isOwner && <option value="MANAGER">Manager</option>}
                      </select>
                    </F>
                    <F label="Send by">
                      <select value={inv.channel} onChange={(e) => setInv({ ...inv, channel: e.target.value as "EMAIL" })} data-testid="invite-channel">
                        <option value="EMAIL">Email{canEmail ? "" : " (not connected — link only)"}</option>
                        <option value="SMS">Text message{canSms ? "" : " (not connected — link only)"}</option>
                        <option value="BOTH">Email and text</option>
                        <option value="LINK">Just give me a link (text it, share it in person)</option>
                      </select>
                    </F>
                  </div>
                  <div className="setup-wiz-actions">
                    <Button variant="ghost" onClick={() => setInviting(null)}>Cancel</Button>
                    <Button type="submit" disabled={busy || (!inv.email && !inv.phone)} data-testid="invite-send">{busy ? "Sending…" : inv.channel === "LINK" ? "Create link" : "Send invitation"}</Button>
                  </div>
                </form>
              )}
              {link?.staff === s.id && (
                <div className="setup-invite-link" data-testid="invite-link">
                  <input readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} aria-label="Invitation link" />
                  <Button variant="secondary" onClick={async () => { setNotice((await copy(link.url)) ? "Link copied." : "Select and copy the link."); }}><Icon name="copy" size={14} /> Copy</Button>
                  <small className="helper">{link.sent.length ? `Also sent by ${link.sent.join(" and ")}. ` : ""}Works for 7 days, once. Anyone with it can join as this person — share it privately.</small>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <form className="setup-add" onSubmit={(e) => { e.preventDefault(); run(addBarber, setError); }}>
        <F label="Add someone"><input value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} placeholder="Their name" maxLength={100} data-testid="setup-add-name" /></F>
        <F label="Job title"><input value={adding.role} onChange={(e) => setAdding({ ...adding, role: e.target.value })} placeholder="Barber" maxLength={50} list="setup-roles" /><datalist id="setup-roles"><option value="Barber" /><option value="Senior barber" /><option value="Stylist" /><option value="Colourist" /><option value="Apprentice" /><option value="Nail tech" /><option value="Receptionist" /></datalist></F>
        <Button type="submit" variant="secondary" disabled={busy || adding.name.trim().length < 2} data-testid="setup-add-staff"><Icon name="plus" size={14} /> Add</Button>
      </form>
      <p className="helper">Hours, photos, skills and pay for each person are in <button type="button" className="linklike" onClick={() => goTo("Team")}>Team</button>.</p>
      <StepActions busy={busy} nextLabel="Continue" onNext={onNext} onSkip={onSkip} skipLabel="It's just me" />
    </div>
  );
}

// ---- 5. Messages ---------------------------------------------------------------------------------
type Msg = { msg_sms: number; msg_email: number; msg_wa: number; msg_reminders: number; msg_reminder_hours: number; msg_reply_to: string; msg_sms_sender: string };
type SmsBilling = { unit_pence: number; included_units: number; acknowledged_at: number | null; live: boolean };
export function StepMessages({ w, api, refresh, data, setNotice, setError, onNext, onSkip }: StepProps) {
  const shop = w.shop as typeof w.shop & { phone?: string; email?: string; msg_sms?: number; msg_email?: number; msg_wa?: number; msg_reminders?: number; msg_reminder_hours?: number; msg_reply_to?: string; msg_sms_sender?: string };
  const suggested = suggestSenders(shop.name)[0] || "";
  const [m, setM] = useState<Msg>({ msg_sms: shop.msg_sms ?? 1, msg_email: shop.msg_email ?? 1, msg_wa: shop.msg_wa ?? 1, msg_reminders: shop.msg_reminders ?? 1, msg_reminder_hours: shop.msg_reminder_hours ?? 24, msg_reply_to: shop.msg_reply_to || shop.email || "", msg_sms_sender: shop.msg_sms_sender || suggested });
  useSetupDirty(m.msg_sms !== (shop.msg_sms ?? 1) || m.msg_email !== (shop.msg_email ?? 1) || m.msg_reminders !== (shop.msg_reminders ?? 1) || m.msg_reminder_hours !== (shop.msg_reminder_hours ?? 24) || m.msg_reply_to !== (shop.msg_reply_to || shop.email || "") || m.msg_sms_sender !== (shop.msg_sms_sender || suggested));
  const [bill, setBill] = useState<SmsBilling | null>(null);
  const [ack, setAck] = useState(false);
  const [test, setTest] = useState<{ channel: string; ok: boolean; note: string } | null>(null);
  const { busy, run } = useBusy();
  useEffect(() => {
    api<{ sms_billing?: SmsBilling }>("/notifications").then((r) => setBill(r.sms_billing ?? null)).catch(() => setBill(null));
  }, []);
  const ps = data.progress.messages.providers;
  const emailLive = ps.email.provider !== "mailbox";
  const barber = w.staff[0]?.name.split(" ")[0] || "Sam";
  const svc = w.services[0]?.name || "Haircut";
  const preview = `${shop.name}: you're booked — ${svc} with ${barber}, Fri 12 Sep at 10:30. Ref BRB-0412. Move or cancel: ${location.origin}/m/a1b2c3`;
  const needsAck = m.msg_sms === 1 && !!bill && !bill.acknowledged_at;
  async function save() {
    await api("/shop/messaging", "PUT", { ...m, ...(needsAck ? { sms_billing_ack: ack } : {}) });
    await refresh();
    if (needsAck && ack) setBill((b) => (b ? { ...b, acknowledged_at: Date.now() } : b));
  }
  async function sendTest(channel: "SMS" | "EMAIL") {
    await save();
    const to = channel === "SMS" ? shop.phone : shop.email || w.account?.email;
    if (!to) throw new Error(channel === "SMS" ? "Add the shop mobile in step 1 first." : "Add the shop email in step 1 first.");
    const r = await api<{ notification: { status: string; provider: string; error: string } | null }>("/notifications/test", "POST", { channel, to });
    const n = r.notification;
    setTest({ channel, ok: n?.status === "SENT", note: n?.status === "SENT" ? (n.provider === "mailbox" ? "Landed in the dev mailbox (no provider connected)." : `Sent via ${n.provider} to ${to}.`) : n?.error || "Not sent yet." });
  }
  const unit = bill?.unit_pence ?? 8;
  return (
    <div className="setup-wiz-card">
      <p className="setup-wiz-lead">Confirmations, reminders and "you're next" texts go out in your shop's name — never ours. Pick the name customers will see, and choose your channels.</p>
      <SmsSenderField value={m.msg_sms_sender} onChange={(v) => setM({ ...m, msg_sms_sender: v })} shopName={shop.name} sampleBody={preview} testId="setup-sms-sender" />
      <div className="setup-channels">
        <div className={`setup-channel${m.msg_sms ? " on" : ""}`} data-testid="setup-channel-sms">
          <label className="setup-check">
            <input type="checkbox" checked={!!m.msg_sms} onChange={(e) => setM({ ...m, msg_sms: e.target.checked ? 1 : 0 })} data-testid="setup-msg-sms" />
            <span>
              <strong>Send texts</strong>
              <small>{unit}p per text · itemised on your invoice{bill && !bill.live ? " · not connected on this deployment yet (texts show in the dev mailbox)" : ""}</small>
            </span>
          </label>
          {m.msg_sms === 1 && bill && <SmsBillingAck unitPence={unit} acknowledgedAt={bill.acknowledged_at} checked={ack} onChange={setAck} testId="setup-sms-billing-ack" />}
        </div>
        <div className={`setup-channel${m.msg_email ? " on" : ""}`}>
          <label className="setup-check">
            <input type="checkbox" checked={!!m.msg_email} onChange={(e) => setM({ ...m, msg_email: e.target.checked ? 1 : 0 })} />
            <span>
              <strong>Send emails</strong>
              <small>Free · branded with your logo{emailLive ? "" : " · not connected on this deployment yet"}</small>
            </span>
          </label>
        </div>
      </div>
      <div className="setup-msg-form setup-msg-grid">
        <F label="Email replies go to"><input type="email" value={m.msg_reply_to} onChange={(e) => setM({ ...m, msg_reply_to: e.target.value })} maxLength={120} /></F>
        <F label="Reminder">
          <select value={m.msg_reminders ? m.msg_reminder_hours : 0} onChange={(e) => { const v = Number(e.target.value); setM({ ...m, msg_reminders: v ? 1 : 0, msg_reminder_hours: v || 24 }); }}>
            <option value={0}>No reminder</option><option value={24}>24 hours before</option><option value={48}>48 hours before</option><option value={4}>4 hours before</option>
          </select>
        </F>
      </div>
      <div className="setup-test">
        <Button variant="secondary" disabled={busy || !shop.phone || (needsAck && !ack)} onClick={() => run(() => sendTest("SMS"), setError)} data-testid="setup-test-sms"><Icon name="phone" size={14} /> Text me a test</Button>
        <Button variant="secondary" disabled={busy} onClick={() => run(() => sendTest("EMAIL"), setError)} data-testid="setup-test-email"><Icon name="message" size={14} /> Email me a test</Button>
        {test && <p className={test.ok ? "workspace-success" : "workspace-error"} role="status" data-testid="setup-test-result">{test.note}</p>}
        {!shop.phone && <small className="helper">Add the shop mobile in step 1 to test texts.</small>}
      </div>
      {needsAck && !ack && <p className="helper" data-testid="setup-sms-ack-hint">Tick the box above to switch texts on, or untick "Send texts" to continue without them.</p>}
      <StepActions busy={busy} onNext={() => run(async () => { if (needsAck && !ack) throw new Error("Please confirm the per-text price, or switch texts off."); await save(); setNotice("Message settings saved."); await onNext(); }, setError)} onSkip={onSkip} />
    </div>
  );
}

// ---- 6. Online booking -----------------------------------------------------------------------------
export function StepOnline({ w, api, refresh, setNotice, setError, goTo, onNext, onSkip }: StepProps) {
  const [slug, setSlug] = useState(w.shop.slug || "");
  const [check, setCheck] = useState<{ ok: boolean; reason: string } | null>(null);
  const [share, setShare] = useState<{ url: string; page: string; qr: string; embed: string } | null>(null);
  const [lead, setLead] = useState(w.shop.lead_time_min ?? 60);
  const [window_, setWindow] = useState(w.shop.booking_window_days ?? 42);
  const { busy, run } = useBusy();
  const timer = useRef(0);
  useSetupDirty(slug !== (w.shop.slug || "") || lead !== (w.shop.lead_time_min ?? 60) || window_ !== (w.shop.booking_window_days ?? 42));
  useEffect(() => {
    if (!w.shop.slug) api<{ slug: string }>("/setup/slug/suggest").then((r) => { setSlug(value => value || r.slug); }).catch(() => {});
    else api<typeof share>("/setup/share").then(setShare).catch(() => {});
  }, []);
  useEffect(() => {
    let cancelled = false;
    setCheck(null);
    window.clearTimeout(timer.current);
    if (!slug) return;
    timer.current = window.setTimeout(() => api<{ ok: boolean; reason: string }>(`/setup/slug?slug=${encodeURIComponent(slug)}`)
      .then(value => { if (!cancelled) setCheck(value); })
      .catch(() => { if (!cancelled) setCheck({ ok: false, reason: "Could not check this address. Try again." }); }), 250);
    return () => { cancelled = true; window.clearTimeout(timer.current); };
  }, [slug]);
  const live = !!w.shop.slug && w.shop.online_booking === 1;
  const ready = w.services.some((s) => s.active) && w.staff.some((s) => s.active);
  async function save(on: boolean) {
    const r = await api<{ shop: typeof w.shop }>("/shop/online", "PUT", { slug: slug.toLowerCase(), online_booking: on ? 1 : 0, lead_time_min: lead, booking_window_days: window_, version: w.shop.version });
    await refresh();
    if (r.shop.slug) setShare(await api("/setup/share"));
    setNotice(on ? `You're live at ${location.host}/book/${r.shop.slug}.` : "Address saved. Switch on when you're ready.");
  }
  return (
    <div className="setup-wiz-card">
      <p className="setup-wiz-lead">Your booking link. Put it in your Instagram bio, on Google, on the window. Customers pick a barber, a service and a time. Confirmations use the message channels you have connected.</p>
      <div className="setup-slug">
        <F label="Web address" hint={check?.reason || (check?.ok ? "Available" : " ")}>
          <div className="setup-slug-input" data-ok={check?.ok} data-bad={check ? !check.ok : undefined}>
            <span>{location.host}/book/</span>
            <input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-"))} maxLength={40} data-testid="setup-slug" />
            {check?.ok && <Icon name="check" size={16} />}
          </div>
        </F>
        <div className="setup-grid-2">
          <F label="Shortest notice" hint="How close to the time someone can book."><select value={lead} onChange={(e) => setLead(Number(e.target.value))}><option value={0}>Right up to the slot</option><option value={30}>30 minutes</option><option value={60}>1 hour</option><option value={120}>2 hours</option><option value={1440}>A day</option></select></F>
          <F label="How far ahead" hint="How many days into the future the calendar opens."><select value={window_} onChange={(e) => setWindow(Number(e.target.value))}><option value={14}>2 weeks</option><option value={28}>4 weeks</option><option value={42}>6 weeks</option><option value={90}>3 months</option></select></F>
        </div>
      </div>
      {!ready && <p className="workspace-error" role="alert">Add at least one service and one team member before going live — otherwise there's nothing to book.</p>}
      {share?.qr && (
        <div className="setup-share" data-testid="setup-share">
          <img src={share.qr} alt={`QR code for ${share.url}`} width={140} height={140} />
          <div>
            <p><strong>{live ? "Live now." : "Ready to go live."}</strong> <a href={share.url} target="_blank" rel="noreferrer">{share.url.replace(/^https?:\/\//, "")}</a></p>
            <div className="setup-share-actions">
              <Button variant="secondary" onClick={async () => setNotice((await copy(share.url)) ? "Booking link copied." : "Select and copy the link.")}><Icon name="copy" size={14} /> Copy link</Button>
              <Button variant="secondary" onClick={async () => setNotice((await copy(share.embed)) ? "Button code copied — paste it into your website." : "Could not copy.")}><Icon name="globe" size={14} /> Website button</Button>
              <a className="button ghost" href={share.qr} download={`${w.shop.slug}-qr.png`}><Icon name="download" size={14} /> QR for the window</a>
            </div>
            <small className="helper">Your shop page — photos, reviews, team — is at <a href={share.page} target="_blank" rel="noreferrer">{share.page.replace(/^https?:\/\//, "")}</a>. Set it up under <button type="button" className="linklike" onClick={() => goTo("Settings")}>Settings → Shop page</button>.</small>
          </div>
        </div>
      )}
      <StepActions busy={busy} nextLabel={live ? "Continue" : ready && check?.ok ? "Go live and continue" : "Save address and continue"} onNext={() => run(async () => { if (!slug || (!check?.ok && slug !== w.shop.slug)) throw new Error(check?.reason || "Wait for a valid booking address, or choose Skip for now."); await save(ready && (live || !!check?.ok)); await onNext(); }, setError)} onSkip={onSkip}>
        {live && <Button variant="ghost" disabled={busy} onClick={() => run(() => save(false), setError)}>Switch off</Button>}
      </StepActions>
    </div>
  );
}

// ---- 7. Payments + done ---------------------------------------------------------------------------
type Pay = { stripe: { provider: string; mode: string }; active: boolean; shop_account: { state: { key: string; label: string } } | null; settings: { deposits_online: number; deposit_hold_min: number; payment_mode: string; deposit_pence: number; payout_tier: string; payrun_auto: string; payrun_reserve_bps: number } };
export function StepPayments({ w, api, refresh, data, setNotice, setError, goTo, onNext, onSkip, complete, onExit }: StepProps & { complete: boolean; onExit: () => void }) {
  const [pay, setPay] = useState<Pay | null>(null);
  const [payError, setPayError] = useState("");
  const [payRetry, setPayRetry] = useState(0);
  const [mode, setMode] = useState<"PAY_AT_VISIT" | "DEPOSIT" | "PREPAY">((w.shop.payment_mode as "DEPOSIT") || "DEPOSIT");
  const [deposit, setDeposit] = useState(w.shop.deposit_pence / 100);
  const [cancel, setCancel] = useState(w.shop.cancel_hours);
  const { busy, run } = useBusy();
  useSetupDirty(!complete && (mode !== (w.shop.payment_mode || "DEPOSIT") || deposit !== w.shop.deposit_pence / 100 || cancel !== w.shop.cancel_hours));
  useEffect(() => { let cancelled = false; setPayError(""); api<Pay>("/shop/payments").then(p => { if (!cancelled) setPay(p); }).catch(e => { if (!cancelled) setPayError(e.message || "Could not load payment settings."); }); return () => { cancelled = true; }; }, [payRetry]);
  const stripeOn = pay?.stripe.provider === "stripe";
  const connected = pay?.shop_account?.state.key === "active";
  async function save() {
    if (mode === "DEPOSIT" && (!Number.isFinite(deposit) || deposit <= 0)) throw new Error("Enter a deposit greater than zero.");
    await api("/setup/policy", "PUT", { deposit_pence: Math.round(deposit * 100), cancel_hours: cancel, no_show_grace: w.shop.no_show_grace, payment_mode: mode, version: w.shop.version });
    try {
      if (stripeOn && pay) {
        await api("/shop/payments", "PUT", { ...pay.settings, deposit_pence: Math.round(deposit * 100), deposits_online: mode === "PAY_AT_VISIT" ? 0 : 1, payment_mode: mode });
      }
    } finally { await refresh(); }
  }
  async function connect() {
    await save();
    const r = await api<{ url: string }>("/shop/payments/connect", "POST", {});
    location.href = r.url;
  }
  const p = data.progress;
  const [share, setShare] = useState<{ url: string; page: string; qr: string; embed: string } | null>(null);
  useEffect(() => { if (complete && p.online.slug) api<typeof share>("/setup/share").then(setShare).catch(() => {}); }, [complete, p.online.slug]);
  if (complete) {
    const items = [
      { ok: p.shop.saved, label: "Shop details", go: "shop" },
      { ok: !!p.brand?.logo || !!p.brand?.cover, label: p.brand?.logo ? "Logo and colours set" : p.brand?.cover ? "Cover photo set" : "No logo or photo yet", go: "brand" },
      { ok: p.services.count > 0, label: `${p.services.count} service${p.services.count === 1 ? "" : "s"}`, go: "services" },
      { ok: p.team.staff > 0, label: `${p.team.staff} on the team${p.team.joined ? `, ${p.team.joined} signed in` : p.team.invited ? `, ${p.team.invited} invited` : ""}`, go: "team" },
      { ok: !!p.messages.sms_sender, label: p.messages.sms_sender ? `Texts from "${p.messages.sms_sender}"` : "Text sender name not set", go: "messages" },
      { ok: !!p.terms?.text, label: p.terms?.text ? "Booking terms written" : "No booking terms (defaults apply)", go: "terms" },
      { ok: p.online.live, label: p.online.live ? `Live at /book/${p.online.slug}` : "Online booking is off", go: "online" },
      { ok: p.payments.connected, label: p.payments.connected ? "Card payments connected" : "Card payments not connected (customers pay in the shop)", go: "payments" },
    ];
    return (
      <div className="setup-wiz-card setup-done" data-testid="setup-done">
        <div className="setup-done-hero"><Icon name="sparkles" size={28} /><h3>{p.online.live ? `${w.shop.name} is live.` : "That's the shop set up."}</h3><p>{p.online.live ? "Share the link and start taking bookings." : "Everything below can be changed any time from Settings."}</p></div>
        {p.online.live && share?.qr && (
          <div className="setup-share setup-golive" data-testid="setup-golive">
            <img src={share.qr} alt={`QR code for ${share.url}`} width={140} height={140} />
            <div>
              <p><a href={share.url} target="_blank" rel="noreferrer" data-testid="golive-url">{share.url.replace(/^https?:\/\//, "")}</a></p>
              <div className="setup-share-actions">
                <Button variant="secondary" onClick={async () => setNotice((await copy(share.url)) ? "Booking link copied." : "Select and copy the link.")} data-testid="golive-copy"><Icon name="copy" size={14} /> Copy link</Button>
                {typeof navigator !== "undefined" && "share" in navigator && <Button variant="secondary" onClick={() => navigator.share({ title: w.shop.name, text: `Book at ${w.shop.name}`, url: share.url }).catch(() => {})}><Icon name="external" size={14} /> Share…</Button>}
                <a className="button secondary" href={`sms:?&body=${encodeURIComponent(`Book your next visit at ${w.shop.name}: ${share.url}`)}`}><Icon name="phone" size={14} /> Text it</a>
                <a className="button secondary" href={`https://wa.me/?text=${encodeURIComponent(`Book your next visit at ${w.shop.name}: ${share.url}`)}`} target="_blank" rel="noreferrer"><Icon name="message" size={14} /> WhatsApp</a>
                <a className="button ghost" href={share.qr} download={`${p.online.slug}-qr.png`}><Icon name="download" size={14} /> QR for the window</a>
                <Button variant="ghost" onClick={async () => setNotice((await copy(share.embed)) ? "Button code copied — paste it into your website." : "Could not copy.")}><Icon name="globe" size={14} /> Website button</Button>
              </div>
              <small className="helper">Put it in your Instagram bio and on your Google Business Profile as the booking link. Your shop page is at <a href={share.page} target="_blank" rel="noreferrer">{share.page.replace(/^https?:\/\//, "")}</a>.</small>
            </div>
          </div>
        )}
        <ul className="setup-done-list">
          {items.map((i) => <li key={i.label} data-ok={i.ok}><Icon name={i.ok ? "check" : "right"} size={14} /> <span>{i.label}</span></li>)}
        </ul>
        <div className="setup-wiz-actions">
          {p.online.live && <Button variant="secondary" onClick={async () => setNotice((await copy(`${location.origin}/book/${p.online.slug}`)) ? "Booking link copied." : "")}><Icon name="copy" size={14} /> Copy booking link</Button>}
          <Button onClick={onExit} data-testid="setup-open-calendar">Open the calendar</Button>
        </div>
      </div>
    );
  }
  if (!pay) return <div className="setup-wiz-card">{payError ? <><p role="alert">{payError}</p><Button onClick={() => setPayRetry(n => n + 1)}>Retry payment settings</Button></> : <p role="status">Loading payment settings…</p>}<StepActions nextLabel="Skip payments for now" onNext={() => { onSkip?.(); }} /></div>;
  return (
    <div className="setup-wiz-card">
      <p className="setup-wiz-lead">Choose pay in the shop, a deposit or full payment. Online card collection requires a connected payment provider.</p>
      <div className="setup-kind" role="radiogroup" aria-label="Payment at booking">
        {([["PAY_AT_VISIT", "Pay in the shop", "No card needed to book. Customers pay at their visit."], ["DEPOSIT", "Deposit online", "A fixed amount at booking, the rest at the chair."], ["PREPAY", "Pay in full online", "The whole price at booking. Best for high-value services."]] as const).map(([k, t, d]) => (
          <button key={k} type="button" role="radio" aria-checked={mode === k} onClick={() => setMode(k)} data-testid={`pay-mode-${k}`}><Icon name={k === "PAY_AT_VISIT" ? "banknote" : k === "DEPOSIT" ? "paid" : "card"} /><strong>{t}</strong><span>{d}</span></button>
        ))}
      </div>
      <div className="setup-grid-2">
        {mode === "DEPOSIT" && <F label="Deposit amount" hint="Kept if they cancel late or don't show; taken off the bill otherwise."><div className="setup-money"><span>{w.shop.currency === "EUR" ? "€" : w.shop.currency === "USD" ? "$" : "£"}</span><input type="number" min={1} step={1} value={deposit} onChange={(e) => setDeposit(Number(e.target.value))} data-testid="setup-deposit" /></div></F>}
        <F label="Free cancellation until" hint="After this, the deposit is kept."><select value={cancel} onChange={(e) => setCancel(Number(e.target.value))}><option value={0}>Any time</option><option value={2}>2 hours before</option><option value={12}>12 hours before</option><option value={24}>24 hours before</option><option value={48}>48 hours before</option></select></F>
      </div>
      {mode !== "PAY_AT_VISIT" && (
        <div className="setup-connect" data-testid="setup-connect">
          {!stripeOn ? (
            <p className="helper"><Icon name="lock" size={14} /> Card payments aren't switched on for this deployment yet. Your policy is saved; deposits show as "payable in the shop" until they are.</p>
          ) : connected ? (
            <p className="workspace-success">Card payments are connected. {mode === "DEPOSIT" ? `Deposits of ${money(Math.round(deposit * 100))}` : "Full payment"} will be taken at booking.</p>
          ) : (
            <>
              <p>To take money online the shop needs a payouts account — a five-minute form (business details, bank account, ID). Payout timing depends on your account and payout settings.</p>
              <Button disabled={busy} onClick={() => run(connect, setError)} data-testid="setup-connect-stripe">{busy ? "Opening…" : "Set up payouts"} <Icon name="external" size={14} /></Button>
              <small className="helper">Review your applicable payment fees in <button type="button" className="linklike" onClick={() => goTo("Settings")}>Settings → Payments</button>.</small>
            </>
          )}
        </div>
      )}
      <StepActions busy={busy} nextLabel="Save and finish" onNext={() => run(async () => { await save(); await onNext(); }, setError)} onSkip={onSkip} />
    </div>
  );
}
