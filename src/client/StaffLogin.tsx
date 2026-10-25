// Team → <barber> → Login: set up and manage one team member's sign-in by email. Shows the
// account state (none / invited / active / suspended), sends or resends the invitation from the
// shop, and lets the owner change role or suspend. The invitee lands in StaffOnboarding.
import { PERM_DEFS, effectivePerms } from "../server/perms";
import { useEffect, useState } from "react";
import { ask } from "./confirm";
import type { Staff, WorkspaceData } from "../server/domain";
import { Badge, Button, Icon, Notice } from "./ui";

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Invite = { id: string; staff_id: string; email: string; phone: string; role: string; channel: string; sent_count: number; last_sent_at: number | null; expires_at: number; accepted_at: number | null; revoked: number };
type Member = { id: string; name: string; email: string; staff_id: string | null; role: string; active: number; version: number; onboarded_at?: number | null; permissions_json?: string };
type Access = { members: Member[]; invitations: Invite[]; providers: { email: { provider: string }; sms: { provider: string } } };
const ROLE_LABEL: Record<string, string> = { BARBER: "Barber", RECEPTION: "Reception", MANAGER: "Manager", OWNER: "Owner" };
const ROLE_HINT: Record<string, string> = {
  BARBER: "Their own calendar, customers and pay. Can't change settings.",
  RECEPTION: "Everyone's calendar and the till. No pay or settings.",
  MANAGER: "Everything except billing and who can sign in.",
  OWNER: "Everything: insights, pay, settings, billing and the team. Each shop has one owner.",
};
function PermissionBoxes({ member, disabled, onSave }: { member: Member; disabled: boolean; onSave: (p: Record<string, boolean>) => void }) {
  // What this person can do now: their role's defaults with the owner's changes on top.
  const initial = effectivePerms(member.role, member.permissions_json) as Record<string, boolean>;
  const [p, setP] = useState<Record<string, boolean>>(initial);
  useEffect(() => { setP(initial); }, [member.id, member.role, member.permissions_json]);
  const changed = PERM_DEFS.some((x) => !!p[x.key] !== !!initial[x.key]);
  const groups = [...new Set(PERM_DEFS.map((d) => d.group))];
  return (
    <fieldset className="staff-login-perms" data-testid="staff-login-perms">
      <legend>What {member.name.split(" ")[0]} can do</legend>
      <small className="helper">Everyone sees the same calendar. These switches choose which features each account can use.</small>
      {groups.map((g) => (
        <div key={g} className="perm-group">
          <strong>{g}</strong>
          {PERM_DEFS.filter((x) => x.group === g).map((x) => (
            <label key={x.key} className="setup-check">
              <input type="checkbox" checked={!!p[x.key]} disabled={disabled} onChange={(e) => setP({ ...p, [x.key]: e.target.checked })} data-testid={`perm-${x.key}`} />
              <span>{x.label}<small className="helper"> {x.hint}</small></span>
            </label>
          ))}
        </div>
      ))}
      <Button variant="secondary" disabled={disabled || !changed} onClick={() => onSave(p)} data-testid="perm-save">Save access</Button>
    </fieldset>
  );
}
// The team's sign-in address: the shop's own host. The platform root comes from the page (it can be
// foliyo.co.uk, where "last two labels" would wrongly give co.uk), else the current host.
function staffAddress(slug: string | null | undefined) {
  const root = document.querySelector<HTMLMetaElement>('meta[name="foliyo-root"]')?.content || "";
  if (!slug || !root || /^(localhost|\d+\.\d+\.\d+\.\d+)(:\d+)?$/.test(root)) return `${location.host}/staff`;
  return `${slug}.${root.replace(/^www\./, "")}/staff`;
}
async function copy(text: string) { try { await navigator.clipboard.writeText(text); return true; } catch { return false; } }

export function StaffLoginPanel({ w, api, staff, onChanged }: { w: WorkspaceData; api: Api; staff: Staff; onChanged?: () => void }) {
  const [access, setAccess] = useState<Access | null>(null);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<"BARBER" | "RECEPTION" | "MANAGER" | "OWNER">("BARBER");
  const [alsoText, setAlsoText] = useState(false);
  const [link, setLink] = useState("");
  const [state, setState] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const isOwner = w.account?.role === "OWNER";
  const load = () => api<Access>("/auth/access").then(setAccess).catch((e) => setState({ kind: "error", text: e instanceof Error ? e.message : "Could not load access." }));
  useEffect(() => { load(); }, [staff.id, staff.version]);
  const shopLogin = !!(w.account as { shop_account?: boolean } | null)?.shop_account;
  const canNameOwner = shopLogin && !!access && !access.members.some((m) => m.role === "OWNER") && !access.invitations.some((i) => i.role === "OWNER" && !i.accepted_at && !i.revoked && i.expires_at > Date.now());
  const member = access?.members.find((m) => m.staff_id === staff.id);
  const pending = access?.invitations.find((i) => i.staff_id === staff.id && !i.accepted_at && !i.revoked && i.expires_at > Date.now());
  const canSms = access?.providers.sms.provider !== "mailbox";
  async function run(fn: () => Promise<string>) {
    setBusy(true); setState(null);
    try { const t = await fn(); await load(); onChanged?.(); if (t) setState({ kind: "ok", text: t }); } catch (e) { setState({ kind: "error", text: e instanceof Error ? e.message : "Something went wrong." }); } finally { setBusy(false); }
  }
  const invite = () => run(async () => {
    const r = await api<{ link: string; sent: string[] }>("/auth/invites", "POST", { staff_id: staff.id, email: email.trim(), phone: alsoText ? phone.trim() : "", role, channel: alsoText && phone.trim() ? "BOTH" : "EMAIL" });
    setLink(r.link);
    return r.sent.length ? `Invitation emailed to ${email.trim()}${r.sent.includes("sms") ? " and texted" : ""}. It lasts 7 days.` : "Invitation created — share the link below.";
  });
  const resend = (i: Invite) => run(async () => {
    const r = await api<{ link: string; sent: string[] }>(`/auth/invites/${i.id}/resend`, "POST", {});
    setLink(r.link);
    return r.sent.length ? "Sent again. The old link no longer works." : "New link ready to share.";
  });
  const revoke = (i: Invite) => run(async () => { await api(`/auth/invites/${i.id}/revoke`, "POST", {}); setLink(""); return "Invitation withdrawn."; });
  const setMember = (m: Member, patch: { role?: string; active?: number }) => run(async () => {
    await api(`/auth/members/${m.id}`, "PUT", { role: patch.role ?? m.role, active: patch.active ?? m.active, version: m.version });
    return patch.active === 0 ? `${m.name} can no longer sign in.` : patch.active === 1 ? `${m.name} can sign in again.` : "Role updated.";
  });
  if (!access) return <p role="status">Loading login…</p>;
  return (
    <div className="staff-login" data-testid="staff-login">
      {member ? (
        <section className="staff-login-card" data-testid="staff-login-active">
          <header>
            <Badge tone={member.active ? "" : "warning"}>{member.active ? "Can sign in" : "Suspended"}</Badge>
            <h3>{member.name}</h3>
            <p><Icon name="message" size={14} /> {member.email} · {ROLE_LABEL[member.role] || member.role}{member.onboarded_at ? "" : " · hasn't finished onboarding yet"}</p>
          </header>
          <p className="helper">Signs in at <b>{staffAddress(w.shop.slug)}</b> with their email and password. Forgotten password? They use "Forgot password" on that page — nothing for you to do.</p>
          {isOwner && (
            <div className="staff-login-controls">
              <label className="workspace-field">
                <span>Role</span>
                <select value={member.role} disabled={busy} onChange={(e) => setMember(member, { role: e.target.value })} data-testid="staff-login-role">
                  {(["BARBER", "RECEPTION", "MANAGER"] as const).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
                <small className="helper">{ROLE_HINT[member.role]}</small>
              </label>
              {(
                <PermissionBoxes member={member} disabled={busy} onSave={(p) => run(async () => { await api(`/auth/members/${member.id}/permissions`, "PUT", p); return "Access saved. It applies straight away."; })} />
              )}
              <div className="workspace-field">
                <span>Access</span>
                {member.active ? (
                  <Button variant="secondary" disabled={busy} onClick={async () => { if (await ask({ title: `Stop ${member.name} signing in?`, body: "Their bookings and history stay.", confirm: "Suspend sign-in", tone: "danger" })) setMember(member, { active: 0 }); }} data-testid="staff-login-suspend"><Icon name="lock" size={14} /> Suspend sign-in</Button>
                ) : (
                  <Button disabled={busy} onClick={() => setMember(member, { active: 1 })} data-testid="staff-login-restore"><Icon name="check" size={14} /> Restore sign-in</Button>
                )}
              </div>
            </div>
          )}
        </section>
      ) : pending ? (
        <section className="staff-login-card" data-testid="staff-login-pending">
          <header>
            <Badge tone="note">Invited</Badge>
            <h3>Waiting for {staff.name.split(" ")[0]} to accept</h3>
            <p><Icon name="message" size={14} /> {pending.email.endsWith("@sms.invite") ? `Texted to ••••${pending.phone.slice(-3)}` : pending.email} · {ROLE_LABEL[pending.role]} · sent {pending.sent_count}× · expires {new Date(pending.expires_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</p>
          </header>
          <p className="helper">They open the link, choose a password and get a short welcome tour. If it hasn't arrived, check spam or send it again.</p>
          <div className="panel-actions-row">
            <Button variant="secondary" disabled={busy} onClick={() => resend(pending)} data-testid="staff-login-resend"><Icon name="message" size={14} /> Send again</Button>
            <Button variant="ghost" disabled={busy} onClick={async () => setState({ kind: "ok", text: (await copy(link || "")) && link ? "Link copied." : "Send again to get a fresh link to copy." })}><Icon name="copy" size={14} /> Copy link</Button>
            <Button variant="ghost" disabled={busy} onClick={async () => { if (await ask({ title: "Withdraw this invitation?", confirm: "Withdraw", tone: "danger" })) revoke(pending); }} data-testid="staff-login-revoke">Withdraw</Button>
          </div>
        </section>
      ) : (
        <section className="staff-login-card" data-testid="staff-login-none">
          <header>
            <Badge>No login yet</Badge>
            <h3>Give {staff.name.split(" ")[0]} their own sign-in</h3>
            <p>They'll get an email from {w.shop.name} with a link to set a password. First sign-in walks them through their profile, their week and adding the app to their phone.</p>
          </header>
          {!staff.active && <Notice>This profile is inactive — make it active before inviting.</Notice>}
          <form className="staff-login-form" onSubmit={(e) => { e.preventDefault(); if (email.trim()) invite(); }}>
            <label className="workspace-field"><span>Their email</span><input type="email" required value={email} maxLength={254} placeholder="name@example.com" onChange={(e) => setEmail(e.target.value)} data-testid="staff-login-email" /></label>
            <label className="workspace-field">
              <span>Role</span>
              <select value={role} onChange={(e) => setRole(e.target.value as typeof role)} data-testid="staff-login-role-new">
                <option value="BARBER">Barber</option>
                <option value="RECEPTION">Reception</option>
                {canNameOwner && <option value="OWNER">Owner</option>}
                {isOwner && <option value="MANAGER">Manager</option>}
              </select>
              <small className="helper">{ROLE_HINT[role]}</small>
            </label>
            {canSms && (
              <label className="setup-check">
                <input type="checkbox" checked={alsoText} onChange={(e) => setAlsoText(e.target.checked)} />
                <span>Also text the link</span>
              </label>
            )}
            {alsoText && canSms && <label className="workspace-field"><span>Their mobile</span><input type="tel" inputMode="tel" value={phone} maxLength={20} placeholder="07700 900123" onChange={(e) => setPhone(e.target.value)} /></label>}
            <div className="panel-actions-row">
              <Button type="submit" disabled={busy || !staff.active || !email.trim()} data-testid="staff-login-invite"><Icon name="message" size={14} /> {busy ? "Sending…" : "Email invitation"}</Button>
            </div>
          </form>
        </section>
      )}
      {link && (
        <div className="account-invite-link" data-testid="staff-login-link">
          <label className="workspace-field"><span>Invitation link (7 days, one use)</span><textarea readOnly value={link} rows={2} onFocus={(e) => e.currentTarget.select()} /></label>
          <Button variant="ghost" onClick={async () => setState({ kind: "ok", text: (await copy(link)) ? "Link copied." : "Select and copy the link." })}><Icon name="copy" size={14} /> Copy</Button>
        </div>
      )}
      {state && <p className={state.kind === "error" ? "workspace-error" : "workspace-success"} role={state.kind === "error" ? "alert" : "status"}>{state.text}</p>}
    </div>
  );
}
