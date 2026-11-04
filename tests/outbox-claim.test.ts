// The outbox must hand each message to exactly one sender, however many drains overlap. In production
// several run at once (Vercel cron, the lazy sweep after any API call, un-scoped drain() calls after
// writes). A claim that accepted any SENDING row let a second drain re-take a row the first had just
// claimed, so the same customer was texted twice — the copy was then rejected by the carrier (40008).
// Runs against the real local Postgres with a fake Telnyx that counts sends per recipient.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { makeDb } from "../src/db/client";
import { drain } from "../src/server/messaging";

const envFile = existsSync(".env.local") ? ".env.local" : ".env";
const dbUrl = process.env.DATABASE_URL || readFileSync(envFile, "utf8").split("\n").find((l) => l.startsWith("DATABASE_URL="))!.slice("DATABASE_URL=".length);
const db = makeDb(dbUrl, { max: 8 } as never);
const shop = `claim-test-${Date.now()}`;
const KEYS = ["TELNYX_API_KEY", "TELNYX_MESSAGING_PROFILE_ID", "TELNYX_FROM"] as const;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.TELNYX_API_KEY = "KEY_fake";
  process.env.TELNYX_MESSAGING_PROFILE_ID = "prof_fake";
  process.env.TELNYX_FROM = "+447700900000";
  await db.prepare("INSERT INTO shops(id,name,created_at,msg_sms_sender) VALUES(?,?,?,?)").bind(shop, "Claim Test Barbers", Date.now(), "ClaimTest").run();
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  // Notifications are append-only by trigger (notification_immutable), so the fictional test shop and
  // its rows stay behind, like the other database tests' shops.
  await (db.sql as import("postgres").Sql).end();
});

async function queue(n: number, dueAt: number, tag: string) {
  for (let i = 0; i < n; i++) {
    await db.prepare("INSERT INTO notifications(id,shop_id,channel,recipient,template,body,status,related_type,related_id,created_at,next_attempt_at) VALUES(?,?,'SMS',?,'shop_announcement','Hello from the shop','QUEUED','test',?,?,?)")
      .bind(`${shop}-${tag}-${i}`, shop, `+44770090${String(1000 + i).slice(-4)}`, `${tag}:${i}`, Date.now(), dueAt).run();
  }
}
function fakeTelnyx() {
  const sends = new Map<string, number>();
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const to = JSON.parse(init.body as string).to as string;
    sends.set(to, (sends.get(to) || 0) + 1);
    await new Promise((r) => setTimeout(r, 25)); // a real provider call takes time, which is when overlap happens
    return new Response(JSON.stringify({ data: { id: `msg_${to}_${sends.get(to)}` } }), { status: 200 });
  });
  return sends;
}

describe("outbox claim", () => {
  it("overlapping drains send each queued text exactly once", async () => {
    const now = Date.now();
    await queue(30, now - 1000, "race");
    const sends = fakeTelnyx();
    // Four drains at once, same clock — the cron, the lazy sweep and two post-write drains.
    await Promise.all([drain(db, 100, now), drain(db, 100, now), drain(db, 100, now), drain(db, 100, now)]);
    expect(sends.size).toBe(30);
    expect([...sends.values()].filter((c) => c > 1)).toEqual([]);
    const rows = (await db.prepare("SELECT status, attempts FROM notifications WHERE shop_id=? AND related_id LIKE 'race:%'").bind(shop).all<{ status: string; attempts: number }>()).results;
    expect(rows.every((r) => r.status === "SENT" && Number(r.attempts) === 1)).toBe(true);
  });

  it("a row paused after a drain read it is not sent", async () => {
    const now = Date.now();
    await queue(1, now - 1000, "paused");
    // Simulate: the row was due when selected, then an operator pushed it out before the claim.
    await db.prepare("UPDATE notifications SET next_attempt_at=? WHERE id=?").bind(now + 86400000, `${shop}-paused-0`).run();
    const sends = fakeTelnyx();
    await drain(db, 100, now);
    expect(sends.size).toBe(0);
  });

  it("a SENDING row abandoned for 10+ minutes is still reclaimed (crashed worker)", async () => {
    const now = Date.now();
    await queue(1, now, "stuck");
    await db.prepare("UPDATE notifications SET status='SENDING', attempts=1, next_attempt_at=? WHERE id=?").bind(now - 11 * 60000, `${shop}-stuck-0`).run();
    const sends = fakeTelnyx();
    await drain(db, 100, now);
    expect(sends.size).toBe(1);
  });
});
