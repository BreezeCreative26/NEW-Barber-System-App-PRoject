// Staff onboarding — a barber / receptionist / manager's first sign-in after accepting the shop's
// email invitation. Four short screens in the shop's name: Welcome → Your profile (photo, title,
// bio, Instagram, skills — what customers see) → Your week (hours + services the owner set, read
// only, with "ask the owner" pointers) → Get the app (add to home screen). Finishing stamps
// app_memberships.onboarded_at so it never shows again; "Skip" does the same.
import { useEffect, useMemo, useState } from "react";
import type { WorkspaceData } from "../server/domain";
import { Avatar, Button, Icon } from "./ui";
import { PhotoUpload, PhotoPreview } from "./Media";
import { time } from "./fixtures";

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Step = "welcome" | "profile" | "week" | "app";
const STEPS: { key: Step; label: string }[] = [
  { key: "welcome", label: "Welcome" },
  { key: "profile", label: "Your profile" },
  { key: "week", label: "Your week" },
  { key: "app", label: "Get the app" },
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const initials = (n: string) => n.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();
const ROLE_COPY: Record<string, string> = {
  BARBER: "You'll see your own column, your customers and your pay. Nothing else gets in the way.",
  RECEPTION: "You'll see every barber's diary so you can book, move and check people in.",
  MANAGER: "You have the owner's view of the shop except billing and access.",
};

export function StaffOnboarding({ w, api, refresh, onDone, logoUrl }: { w: WorkspaceData; api: Api; refresh: () => Promise<void>; onDone: () => void; logoUrl?: string }) {
  const account = w.account!;
  const me = w.staff.find((s) => s.id === account.staff_id);
  const [step, setStep] = useState<Step>("welcome");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const idx = STEPS.findIndex((s) => s.key === step);
  const [form, setForm] = useState({
    name: me?.name || account.name,
    title: me?.title || "",
    bio: me?.bio || "",
    photo_url: me?.photo_url || "",
    instagram: me?.instagram || "",
    skills: (() => { try { return JSON.parse(me?.skills || "[]") as string[]; } catch { return []; } })(),
  });
  const [skill, setSkill] = useState("");
  useEffect(() => { window.scrollTo({ top: 0 }); }, [step]);

  const myHours = useMemo(() => w.hours.filter((h) => h.staff_id === account.staff_id), [w.hours, account.staff_id]);
  const myServices = useMemo(() => w.services.filter((s) => s.active && !w.service_rules.some((r) => r.staff_id === account.staff_id && r.service_id === s.id && !r.enabled)), [w.services, w.service_rules, account.staff_id]);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError("");
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "Something went wrong."); } finally { setBusy(false); }
  }
  async function saveProfile() {
    if (!account.staff_id) return;
    await api("/me/profile", "PUT", { name: form.name.trim(), title: form.title.trim(), bio: form.bio.trim(), photo_url: form.photo_url, instagram: form.instagram.trim(), skills: form.skills });
    await refresh();
  }
  async function finish() {
    await api("/me/onboarded", "POST", {});
    await refresh();
    onDone();
  }
  const next = () => setStep(STEPS[Math.min(idx + 1, STEPS.length - 1)].key);
  const installable = typeof navigator !== "undefined" && !window.matchMedia("(display-mode: standalone)").matches;
  const isIOS = typeof navigator !== "undefined" && /iphone|ipad|ipod/i.test(navigator.userAgent);

  return (
    <section className="staff-onb" aria-labelledby="staff-onb-heading" data-testid="staff-onboarding">
      <header className="staff-onb-top">
        <span className="staff-onb-brand">
          {logoUrl ? <img src={logoUrl} alt="" /> : <span className="shop-emblem">{initials(w.shop.name)}</span>}
          <b>{w.shop.name}</b>
        </span>
        <ol className="staff-onb-dots" aria-label="Progress">
          {STEPS.map((s, i) => <li key={s.key} data-current={s.key === step} data-done={i < idx} aria-label={s.label} />)}
        </ol>
        <button type="button" className="linklike" onClick={() => run(finish)} disabled={busy} data-testid="staff-onb-skip">Skip</button>
      </header>
      {error && <p className="workspace-error" role="alert">{error}</p>}

      <div className="staff-onb-body">
        {step === "welcome" && (
          <div className="staff-onb-card staff-onb-welcome" data-testid="staff-onb-welcome">
            <Avatar initials={initials(form.name)} colour={me?.colour || "sage"} src={form.photo_url || undefined} size="large" />
            <p className="setup-wiz-kicker">Welcome to the team</p>
            <h1 id="staff-onb-heading">Hi {form.name.split(" ")[0]}, you're in.</h1>
            <p className="staff-onb-lead">{w.shop.name} has set you up as <b>{account.role === "BARBER" ? me?.role || "Barber" : account.role.charAt(0) + account.role.slice(1).toLowerCase()}</b>. {ROLE_COPY[account.role] || ""}</p>
            <ul className="staff-onb-list">
              <li><Icon name="check" size={16} /> Sign in any time at <b>{location.host}/staff</b> with {account.email}</li>
              <li><Icon name="check" size={16} /> Two minutes now to set up your profile and get the app on your phone</li>
            </ul>
            <div className="setup-wiz-actions">
              <Button onClick={next} data-testid="staff-onb-next">Let's go</Button>
            </div>
          </div>
        )}

        {step === "profile" && (
          <div className="staff-onb-card" data-testid="staff-onb-profile">
            <p className="setup-wiz-kicker">Step 1 of 3</p>
            <h1 id="staff-onb-heading">Your profile</h1>
            <p className="staff-onb-lead">{account.staff_id ? "This is what customers see when they pick you on the shop page and in the booking flow." : "Your name as it appears to the team."}</p>
            <div className="staff-onb-profile">
              <div className="staff-onb-photo">
                <PhotoPreview url={form.photo_url} label="your photo" onClear={() => setForm({ ...form, photo_url: "" })} />
                {!form.photo_url && <Avatar initials={initials(form.name)} colour={me?.colour || "sage"} size="large" />}
                <PhotoUpload kind="staff" label={form.photo_url ? "Change photo" : "Add a photo"} testId="staff-onb-photo" onUploaded={([u]) => setForm({ ...form, photo_url: u })} />
                <small className="helper">A clear head-and-shoulders shot works best.</small>
              </div>
              <div className="staff-onb-fields">
                <label className="workspace-field"><span>Your name</span><input value={form.name} maxLength={100} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="staff-onb-name" /></label>
                {account.staff_id && (
                  <>
                    <label className="workspace-field"><span>Title <small className="helper" style={{ display: "inline" }}>(optional)</small></span><input value={form.title} maxLength={60} placeholder="Senior barber" onChange={(e) => setForm({ ...form, title: e.target.value })} data-testid="staff-onb-title" /></label>
                    <label className="workspace-field"><span>A line about you <small className="helper" style={{ display: "inline" }}>(optional)</small></span><textarea rows={3} maxLength={600} value={form.bio} placeholder="Fades, beards and a good chat. 8 years behind the chair." onChange={(e) => setForm({ ...form, bio: e.target.value })} data-testid="staff-onb-bio" /></label>
                    <label className="workspace-field"><span>Instagram <small className="helper" style={{ display: "inline" }}>(optional)</small></span><input value={form.instagram} maxLength={40} placeholder="@handle" onChange={(e) => setForm({ ...form, instagram: e.target.value })} /></label>
                    <div className="workspace-field">
                      <span>What you're known for</span>
                      <div className="staff-onb-skills">
                        {form.skills.map((k) => (
                          <button key={k} type="button" className="chip" onClick={() => setForm({ ...form, skills: form.skills.filter((x) => x !== k) })} aria-label={`Remove ${k}`}>{k} <Icon name="close" size={12} /></button>
                        ))}
                        {form.skills.length < 12 && (
                          <input value={skill} maxLength={30} placeholder="Skin fade, beard trim…" onChange={(e) => setSkill(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && skill.trim()) { e.preventDefault(); setForm({ ...form, skills: [...new Set([...form.skills, skill.trim()])] }); setSkill(""); } }} data-testid="staff-onb-skill" />
                        )}
                      </div>
                      <small className="helper">Press Enter after each one.</small>
                    </div>
                  </>
                )}
              </div>
            </div>
            <div className="setup-wiz-actions">
              <Button variant="ghost" onClick={next} disabled={busy}>Later</Button>
              <Button onClick={() => run(async () => { if (account.staff_id) await saveProfile(); next(); })} disabled={busy || form.name.trim().length < 2} data-testid="staff-onb-next">{busy ? "Saving…" : "Save and continue"}</Button>
            </div>
          </div>
        )}

        {step === "week" && (
          <div className="staff-onb-card" data-testid="staff-onb-week">
            <p className="setup-wiz-kicker">Step 2 of 3</p>
            <h1 id="staff-onb-heading">Your week</h1>
            <p className="staff-onb-lead">{account.staff_id ? "The hours and services the shop has set for you. If anything's wrong, tell the owner — they change it under Team." : "The shop's opening hours."}</p>
            <div className="staff-onb-week">
              <dl className="sp-hours staff-onb-hours">
                {[1, 2, 3, 4, 5, 6, 0].map((wd) => {
                  const h = myHours.find((x) => x.weekday === wd);
                  return (
                    <div key={wd} className={h?.enabled ? "" : "off"}>
                      <dt>{DAYS[wd]}</dt>
                      <dd>{h?.enabled ? `${time(h.starts)} – ${time(h.ends)}` : "Off"}</dd>
                    </div>
                  );
                })}
              </dl>
              {account.staff_id && (
                <div className="staff-onb-services">
                  <h3>Services you offer</h3>
                  {myServices.length ? (
                    <ul>{myServices.map((s) => <li key={s.id}><b>{s.name}</b><small>{s.duration_min} min</small></li>)}</ul>
                  ) : (
                    <p className="helper">No services yet — the owner adds them under Services.</p>
                  )}
                </div>
              )}
            </div>
            <div className="setup-wiz-actions">
              <Button onClick={next} data-testid="staff-onb-next">Looks right</Button>
            </div>
          </div>
        )}

        {step === "app" && (
          <div className="staff-onb-card" data-testid="staff-onb-app">
            <p className="setup-wiz-kicker">Step 3 of 3</p>
            <h1 id="staff-onb-heading">Get it on your phone</h1>
            <p className="staff-onb-lead">Add {w.shop.name} to your home screen and it opens like an app — your day, one tap away.</p>
            {installable ? (
              <ol className="staff-onb-install">
                {isIOS ? (
                  <>
                    <li><Icon name="external" size={16} /> Tap the <b>Share</b> button in Safari</li>
                    <li><Icon name="plus" size={16} /> Choose <b>Add to Home Screen</b></li>
                    <li><Icon name="check" size={16} /> Tap <b>Add</b></li>
                  </>
                ) : (
                  <>
                    <li><Icon name="more" size={16} /> Open the browser menu (⋮)</li>
                    <li><Icon name="plus" size={16} /> Choose <b>Install app</b> or <b>Add to Home screen</b></li>
                    <li><Icon name="check" size={16} /> Confirm</li>
                  </>
                )}
              </ol>
            ) : (
              <p className="workspace-success"><Icon name="check" size={16} /> You're already using the app.</p>
            )}
            <p className="helper">On a computer, bookmark <b>{location.host}/staff</b>. You can also do this later from Account.</p>
            <div className="setup-wiz-actions">
              <Button onClick={() => run(finish)} disabled={busy} data-testid="staff-onb-finish">{busy ? "Finishing…" : "Open my day"}</Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
