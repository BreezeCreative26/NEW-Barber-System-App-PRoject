// Shown to the free shop login until the owner has been invited: the owner gets their own profile
// and sign-in on their own device, like any team member.
import { useEffect, useState } from "react";
import { Button, Icon } from "./ui";

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Access = { members: { role: string }[]; invitations: { role: string; accepted_at: number | null; revoked: number; expires_at: number }[] };

export function OwnerInviteBanner({ api, onDone }: { api: Api; onDone: () => void }) {
  const [state, setState] = useState<"loading" | "needed" | "hidden">("loading");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    api<Access>("/auth/access")
      .then((a) => setState(a.members.some((m) => m.role === "OWNER") || a.invitations.some((i) => i.role === "OWNER" && !i.accepted_at && !i.revoked && i.expires_at > Date.now()) ? "hidden" : "needed"))
      .catch(() => setState("hidden"));
  }, []);
  if (state !== "needed") return null;
  async function send() {
    setBusy(true); setMsg(null);
    try {
      const s = await api<{ id: string }>("/staff", "POST", { name: name.trim(), role: "Owner", title: "Owner" });
      const r = await api<{ sent: string[] }>("/auth/invites", "POST", { staff_id: s.id, email: email.trim(), phone: "", role: "OWNER", channel: "EMAIL" });
      setMsg({ ok: true, text: r.sent.length ? `Invitation sent to ${email.trim()}.` : "Invitation created. Share the link from Team." });
      setState("hidden");
      onDone();
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : "Could not send the invitation." }); } finally { setBusy(false); }
  }
  return (
    <section className="setup-banner" data-testid="owner-invite-banner">
      <div>
        <strong>Invite the owner</strong>
        <span>This shop login is for the front desk. The owner signs in on their own device with their own profile, insights and settings.</span>
      </div>
      {!open ? (
        <Button onClick={() => setOpen(true)} data-testid="owner-invite-open"><Icon name="user" size={14} /> Invite the owner</Button>
      ) : (
        <form className="owner-invite-form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <label className="workspace-field"><span>Owner name</span><input required minLength={2} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" data-testid="owner-invite-name" /></label>
          <label className="workspace-field"><span>Owner email</span><input type="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" data-testid="owner-invite-email" /></label>
          <Button type="submit" disabled={busy} data-testid="owner-invite-send">{busy ? "Sending…" : "Send invitation"}</Button>
          {msg && <p role="status" className={msg.ok ? "helper" : "form-error"}>{msg.text}</p>}
        </form>
      )}
    </section>
  );
}
