// Team push: a real browser's PushSubscription.toJSON() carries { endpoint, expirationTime, keys }.
// The route used to reject that shape (400), so no owner, manager or barber device ever saved and no
// push was ever sent. These tests send the real shape for an owner and for a barber login.
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { base, origin, signup, seedCatalogue } from "./shop";

const PASSWORD = "Unique fictional test password 438!";
const uniq = () => crypto.randomUUID().slice(0, 8);
const browserShape = (n: string) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${n}-${uniq()}`,
  expirationTime: null,
  keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" },
});

async function barberLogin(r: APIRequestContext, staffId: string) {
  const email = `barber-${uniq()}@ollo.test`;
  const inv = await r.post(base + "/auth/invites", { data: { email, role: "BARBER", staff_id: staffId } });
  expect(inv.status(), await inv.text()).toBe(201);
  const me = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const acc = await me.post(base + "/auth/accept", { data: { accept_legal: true, token: (await inv.json()).token, name: "Jay Carter", email, password: PASSWORD } });
  expect(acc.status(), await acc.text()).toBe(201);
  return me;
}

test("owner and barber devices can save, see and remove team push exactly as a browser sends it", async () => {
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  await signup(r, "Push Cuts");
  await seedCatalogue(r);
  const w = await (await r.get(base + "/workspace")).json();
  const barber = await barberLogin(r, w.staff[0].id);

  for (const [who, ctx] of [["owner", r], ["barber", barber]] as const) {
    const sub = browserShape(who);
    const before = await (await ctx.get(base + `/inbox/push?endpoint=${encodeURIComponent(sub.endpoint)}`)).json();
    expect(before.subscribed).toBe(false);
    const save = await ctx.post(base + "/inbox/push", { data: sub });
    expect(save.status(), `${who}: ${await save.text()}`).toBe(201);
    const after = await (await ctx.get(base + `/inbox/push?endpoint=${encodeURIComponent(sub.endpoint)}`)).json();
    expect(after.subscribed, who).toBe(true);
    // One person's device is not another's: the other account does not see it as theirs.
    const other = who === "owner" ? barber : r;
    expect((await (await other.get(base + `/inbox/push?endpoint=${encodeURIComponent(sub.endpoint)}`)).json()).subscribed).toBe(false);
    const del = await ctx.delete(base + "/inbox/push", { data: { endpoint: sub.endpoint } });
    expect(del.status(), await del.text()).toBe(200);
    expect((await (await ctx.get(base + `/inbox/push?endpoint=${encodeURIComponent(sub.endpoint)}`)).json()).subscribed).toBe(false);
  }
});

test("junk subscriptions are still refused", async () => {
  const r = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  await signup(r, "Push Junk");
  for (const bad of [{}, { endpoint: "nope", keys: { p256dh: "a", auth: "b" } }, { ...browserShape("x"), extra: 1 }, { endpoint: "https://x.example/a", keys: { p256dh: "a", auth: "b", more: "c" } }]) {
    expect((await r.post(base + "/inbox/push", { data: bad })).status()).toBe(400);
  }
});
