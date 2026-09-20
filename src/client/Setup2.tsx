// Setup wizard steps 4–7. See Setup.tsx for the frame and steps 1–3.
import { useEffect, useRef, useState } from "react";
import type { Staff } from "../server/domain";
import { Badge, Button, Icon } from "./ui";
import { money } from "./fixtures";
import { F, StepActions, useBusy, type StepProps } from "./Setup";

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
  const [link, setLink] = useState<{ staff: string; url: string; sent: string[] } | null>(null);
  const { busy, run } = useBusy();
  const isOwner = w.account?.role === "OWNER";
  const loadAccess = () => api<Access>("/auth/access").then(setAccess).catch(() => setAccess(null));
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
  const canSms = access?.providers.sms.provider !== "mailbox";
  const canEmail = access?.providers.email.provider !== "mailbox";
  return (
    <div className="setup-wiz-card">
      <p className="setup-wiz-lead">Add everyone who takes bookings. Invite them when you're ready — they get their own login and see only their own column.</p>
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
                    <Button variant="secondary" onClick={() => { setInviting(s.id); setInv({ email: "", phone: "", role: "BARBER", channel: canEmail ? "EMAIL" : canSms ? "SMS" : "LINK" }); setLink(null); }} data-testid={`invite-${s.id}`}>Invite</Button>
                  )}
              </div>
              {inviting === s.id && (
                <form className="setup-invite" onSubmit={(e) => { e.preventDefault(); run(() => sendInvite(s), setError); }} data-testid="invite-form">
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
                        <option value="LINK">Just give me a link (WhatsApp, in person)</option>
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
type Msg = { msg_sms: number; msg_email: number; msg_reminders: number; msg_reminder_hours: number; msg_reply_to: string; msg_sms_sender: string };
export function StepMessages({ w, api, refresh, data, setNotice, setError, onNext, onSkip }: StepProps) {
  const shop = w.shop as typeof w.shop & { phone?: string; email?: string; msg_sms?: number; msg_email?: number; msg_reminders?: number; msg_reminder_hours?: number; msg_reply_to?: string; msg_sms_sender?: string };
  const suggested = shop.name.replace(/[^A-Za-z0-9 ]/g, "").replace(/\s+/g, " ").trim().slice(0, 11).trim();
  const [m, setM] = useState<Msg>({ msg_sms: shop.msg_sms ?? 1, msg_email: shop.msg_email ?? 1, msg_reminders: shop.msg_reminders ?? 1, msg_reminder_hours: shop.msg_reminder_hours ?? 24, msg_reply_to: shop.msg_reply_to || shop.email || "", msg_sms_sender: shop.msg_sms_sender || suggested });
  const [test, setTest] = useState<{ channel: string; ok: boolean; note: string } | null>(null);
  const { busy, run } = useBusy();
  const ps = data.progress.messages.providers;
  const smsLive = ps.sms.provider !== "mailbox", emailLive = ps.email.provider !== "mailbox";
  const sender = m.msg_sms_sender || "OLLO";
  const barber = w.staff[0]?.name.split(" ")[0] || "Sam";
  const svc = w.services[0]?.name || "Haircut";
  const preview = `${shop.name}: you're booked — ${svc} with ${barber}, Fri 12 Sep at 10:30. Ref BRB-0412. Move or cancel: ${location.origin}/m/a1b2c3`;
  async function save() {
    await api("/shop/messaging", "PUT", m);
    await refresh();
  }
  async function sendTest(channel: "SMS" | "EMAIL") {
    await save();
    const to = channel === "SMS" ? shop.phone : shop.email || w.account?.email;
    if (!to) throw new Error(channel === "SMS" ? "Add the shop mobile in step 1 first." : "Add the shop email in step 1 first.");
    const r = await api<{ notification: { status: string; provider: string; error: string } | null }>("/notifications/test", "POST", { channel, to });
    const n = r.notification;
    setTest({ channel, ok: n?.status === "SENT", note: n?.status === "SENT" ? (n.provider === "mailbox" ? "Landed in the dev mailbox (no provider connected)." : `Sent via ${n.provider} to ${to}.`) : n?.error || "Not sent yet." });
  }
  return (
    <div className="setup-wiz-card">
      <p className="setup-wiz-lead">Confirmations, reminders and "you're next" texts go out in your shop's name — never ours. Here's exactly what a customer will get.</p>
      <div className="setup-msg">
        <div className="setup-phone" aria-hidden="true">
          <div className="setup-phone-top"><span>{sender}</span></div>
          <div className="setup-phone-bubble">{preview}</div>
          <div className="setup-phone-bubble">{shop.name}: reminder — {svc} with {barber} tomorrow at 10:30. Reply STOP to opt out.</div>
        </div>
        <div className="setup-msg-form">
          <F label="Text sender name" hint="Up to 11 letters/numbers, no spaces at the ends. This is the name at the top of the text. Customers can't reply to it.">
            <input value={m.msg_sms_sender} onChange={(e) => setM({ ...m, msg_sms_sender: e.target.value.replace(/[^A-Za-z0-9 ]/g, "").slice(0, 11) })} maxLength={11} placeholder={suggested} data-testid="setup-sms-sender" />
          </F>
          <F label="Email replies go to"><input type="email" value={m.msg_reply_to} onChange={(e) => setM({ ...m, msg_reply_to: e.target.value })} maxLength={120} /></F>
          <F label="Reminder">
            <select value={m.msg_reminders ? m.msg_reminder_hours : 0} onChange={(e) => { const v = Number(e.target.value); setM({ ...m, msg_reminders: v ? 1 : 0, msg_reminder_hours: v || 24 }); }}>
              <option value={0}>No reminder</option><option value={24}>24 hours before</option><option value={48}>48 hours before</option><option value={4}>4 hours before</option>
            </select>
          </F>
          <div className="setup-toggles">
            <label className="setup-check"><input type="checkbox" checked={!!m.msg_sms} onChange={(e) => setM({ ...m, msg_sms: e.target.checked ? 1 : 0 })} /><span>Send texts {smsLive ? "" : <small className="helper">(texting isn't connected on this deployment yet — they'll show in the dev mailbox)</small>}</span></label>
            <label className="setup-check"><input type="checkbox" checked={!!m.msg_email} onChange={(e) => setM({ ...m, msg_email: e.target.checked ? 1 : 0 })} /><span>Send emails {emailLive ? "" : <small className="helper">(email isn't connected on this deployment yet)</small>}</span></label>
          </div>
          <div className="setup-test">
            <Button variant="secondary" disabled={busy || !shop.phone} onClick={() => run(() => sendTest("SMS"), setError)} data-testid="setup-test-sms"><Icon name="phone" size={14} /> Text me a test</Button>
            <Button variant="secondary" disabled={busy} onClick={() => run(() => sendTest("EMAIL"), setError)} data-testid="setup-test-email"><Icon name="message" size={14} /> Email me a test</Button>
            {test && <p className={test.ok ? "workspace-success" : "workspace-error"} role="status" data-testid="setup-test-result">{test.note}</p>}
            {!shop.phone && <small className="helper">Add the shop mobile in step 1 to test texts.</small>}
          </div>
        </div>
      </div>
      <StepActions busy={busy} onNext={() => run(async () => { await save(); setNotice("Message settings saved."); await onNext(); }, setError)} onSkip={onSkip} />
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
  useEffect(() => {
    if (!w.shop.slug) api<{ slug: string }>("/setup/slug/suggest").then((r) => { if (!slug) setSlug(r.slug); }).catch(() => {});
    else api<typeof share>("/setup/share").then(setShare).catch(() => {});
  }, []);
  useEffect(() => {
    if (!slug) { setCheck(null); return; }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => api<{ ok: boolean; reason: string }>(`/setup/slug?slug=${encodeURIComponent(slug)}`).then(setCheck).catch(() => setCheck(null)), 250);
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
      <p className="setup-wiz-lead">Your booking link. Put it in your Instagram bio, on Google, on the window. Customers pick a barber, a service and a time, and get a text.</p>
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
      <StepActions busy={busy} nextLabel={live ? "Continue" : ready && check?.ok ? "Go live and continue" : "Save address and continue"} onNext={() => run(async () => { if (slug && (check?.ok || slug === w.shop.slug)) await save(ready && (live || !!check?.ok)); await onNext(); }, setError)} onSkip={onSkip}>
        {live && <Button variant="ghost" disabled={busy} onClick={() => run(() => save(false), setError)}>Switch off</Button>}
      </StepActions>
    </div>
  );
}

// ---- 7. Payments + done ---------------------------------------------------------------------------
type Pay = { stripe: { provider: string; mode: string }; active: boolean; shop_account: { state: { key: string; label: string } } | null; settings: { deposits_online: number; deposit_hold_min: number; payment_mode: string; deposit_pence: number; payout_tier: string; payrun_auto: string; payrun_reserve_bps: number } };
export function StepPayments({ w, api, refresh, data, setNotice, setError, goTo, onNext, onSkip, complete, onExit }: StepProps & { complete: boolean; onExit: () => void }) {
  const [pay, setPay] = useState<Pay | null>(null);
  const [mode, setMode] = useState<"PAY_AT_VISIT" | "DEPOSIT" | "PREPAY">((w.shop.payment_mode as "DEPOSIT") || "DEPOSIT");
  const [deposit, setDeposit] = useState(w.shop.deposit_pence / 100);
  const [cancel, setCancel] = useState(w.shop.cancel_hours);
  const { busy, run } = useBusy();
  useEffect(() => { api<Pay>("/shop/payments").then(setPay).catch(() => setPay(null)); }, []);
  const stripeOn = pay?.stripe.provider === "stripe";
  const connected = pay?.shop_account?.state.key === "active";
  async function save() {
    await api("/setup/policy", "PUT", { deposit_pence: Math.round(deposit * 100), cancel_hours: cancel, no_show_grace: w.shop.no_show_grace, payment_mode: mode });
    if (stripeOn && pay && mode !== "PAY_AT_VISIT") {
      await api("/shop/payments", "PUT", { ...pay.settings, deposits_online: 1, payment_mode: mode }).catch(() => {}); // needs an amount > 0 for DEPOSIT; policy just set it
    }
    await refresh();
  }
  async function connect() {
    await save();
    const r = await api<{ url: string }>("/shop/payments/connect", "POST", {});
    location.href = r.url;
  }
  const p = data.progress;
  if (complete) {
    const items = [
      { ok: p.shop.saved, label: "Shop details", go: "shop" },
      { ok: p.services.count > 0, label: `${p.services.count} service${p.services.count === 1 ? "" : "s"}`, go: "services" },
      { ok: p.team.staff > 0, label: `${p.team.staff} on the team${p.team.joined ? `, ${p.team.joined} signed in` : p.team.invited ? `, ${p.team.invited} invited` : ""}`, go: "team" },
      { ok: !!p.messages.sms_sender, label: p.messages.sms_sender ? `Texts from "${p.messages.sms_sender}"` : "Text sender name not set", go: "messages" },
      { ok: p.online.live, label: p.online.live ? `Live at /book/${p.online.slug}` : "Online booking is off", go: "online" },
      { ok: p.payments.connected, label: p.payments.connected ? "Card payments connected" : "Card payments not connected (customers pay in the shop)", go: "payments" },
    ];
    return (
      <div className="setup-wiz-card setup-done" data-testid="setup-done">
        <div className="setup-done-hero"><Icon name="sparkles" size={28} /><h3>That's the shop set up.</h3><p>Everything below can be changed any time from the sidebar.</p></div>
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
  return (
    <div className="setup-wiz-card">
      <p className="setup-wiz-lead">How customers pay. Most shops take a small deposit online — it cuts no-shows in half and the rest is paid at the chair.</p>
      <div className="setup-kind" role="radiogroup" aria-label="Payment at booking">
        {([["PAY_AT_VISIT", "Pay in the shop", "No card needed to book. Simplest, most no-shows."], ["DEPOSIT", "Deposit online", "A fixed amount at booking, the rest at the chair."], ["PREPAY", "Pay in full online", "The whole price at booking. Best for high-value services."]] as const).map(([k, t, d]) => (
          <button key={k} type="button" role="radio" aria-checked={mode === k} onClick={() => setMode(k)} data-testid={`pay-mode-${k}`}><Icon name={k === "PAY_AT_VISIT" ? "banknote" : k === "DEPOSIT" ? "paid" : "card"} /><strong>{t}</strong><span>{d}</span></button>
        ))}
      </div>
      <div className="setup-grid-2">
        {mode === "DEPOSIT" && <F label="Deposit amount" hint="Kept if they cancel late or don't show; taken off the bill otherwise."><div className="setup-money"><span>£</span><input type="number" min={1} step={1} value={deposit} onChange={(e) => setDeposit(Number(e.target.value))} data-testid="setup-deposit" /></div></F>}
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
              <p>To take money online the shop needs a payouts account — a five-minute form (business details, bank account, ID). Money lands in your bank on a daily schedule.</p>
              <Button disabled={busy} onClick={() => run(connect, setError)} data-testid="setup-connect-stripe">{busy ? "Opening…" : "Set up payouts"} <Icon name="external" size={14} /></Button>
              <small className="helper">Fee: card processing plus 1.5% platform fee, shown per payment in <button type="button" className="linklike" onClick={() => goTo("Settings")}>Settings → Payments</button>.</small>
            </>
          )}
        </div>
      )}
      <StepActions busy={busy} nextLabel="Save and finish" onNext={() => run(async () => { await save(); await onNext(); }, setError)} onSkip={onSkip} />
    </div>
  );
}
