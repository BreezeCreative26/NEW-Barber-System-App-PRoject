// Run against local Wrangler only. This deliberately bypasses API pre-checks
// to prove SQLite triggers are the write-time authority, not SELECT-then-write.
import assert from "node:assert/strict";
import { getPlatformProxy } from "wrangler";
const platform = await getPlatformProxy({
  configPath: "wrangler.jsonc",
  persist: { path: ".wrangler/state/v3" },
});
const db = platform.env.DB;
const origin = "http://localhost:3000";
let cookie = "";
async function api(path, method = "GET", body) {
  const r = await fetch(origin + "/api/sandbox" + path, {
    method,
    headers: {
      Origin: origin,
      Cookie: cookie,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  cookie = r.headers.get("set-cookie")?.split(";")[0] || cookie;
  return { status: r.status, body: await r.json() };
}
try {
  assert.equal(
    (await api("/session", "POST", { name: "D1 trigger invariant test" }))
      .status,
    201,
  );
  const w = (await api("/workspace")).body;
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + 6);
  if (day.getUTCDay() === 0) day.setUTCDate(day.getUTCDate() + 1);
  const date = day.toISOString().slice(0, 10);
  const body = {
    request_id: crypto.randomUUID(),
    staff_id: w.staff[0].id,
    service_id: w.services.find((s) => s.duration_min === 30).id,
    customer_name: "Trigger Test",
    phone: "07700900123",
    date,
    start_min: 540,
    source: "TEST_BOOKING",
    quote: { service_version: 0, shop_version: 0 },
  };
  const created = await api("/bookings", "POST", body);
  assert.equal(created.status, 201);
  const b = created.body.booking;
  const columns = Object.keys(b);
  const duplicate = {
    ...b,
    id: crypto.randomUUID(),
    request_id: crypto.randomUUID(),
    sequence: 10000,
    start_min: 555,
    start_at: b.start_at + 15 * 60000,
    end_at: b.end_at + 15 * 60000,
  };
  await assert.rejects(
    () =>
      db
        .prepare(
          `INSERT INTO bookings (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
        )
        .bind(...columns.map((k) => duplicate[k]))
        .run(),
    /slot_taken/,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM bookings WHERE shop_id=?")
        .bind(w.shop.id)
        .first()
    ).n,
    1,
  );
  await assert.rejects(
    () =>
      db
        .prepare("UPDATE bookings SET price_pence=1 WHERE id=?")
        .bind(b.id)
        .run(),
    /booking_snapshot_immutable/,
  );
  await assert.rejects(
    () => db.prepare("DELETE FROM bookings WHERE id=?").bind(b.id).run(),
    /booking_delete_forbidden/,
  );
  await assert.rejects(
    () =>
      db
        .prepare("UPDATE audit_events SET reason='Forged' WHERE shop_id=?")
        .bind(w.shop.id)
        .run(),
    /audit_immutable/,
  );
  await assert.rejects(
    () =>
      db
        .prepare("DELETE FROM audit_events WHERE shop_id=?")
        .bind(w.shop.id)
        .run(),
    /audit_immutable/,
  );
  const second = await api("/bookings", "POST", {
    ...body,
    request_id: crypto.randomUUID(),
    start_min: 900,
  });
  assert.equal(second.status, 201);
  const other = second.body.booking;
  const auditCount = async () =>
    Number(
      (
        await db
          .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE shop_id=?")
          .bind(w.shop.id)
          .first()
      ).n,
    );
  const before = await auditCount();
  await assert.rejects(
    () =>
      db.batch([
        db
          .prepare(
            "INSERT INTO audit_events(id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,'booking',?,'TEST_MOVE','test','Must roll back',?)",
          )
          .bind(crypto.randomUUID(), w.shop.id, b.id, Date.now()),
        db
          .prepare(
            "UPDATE bookings SET start_min=?,start_at=?,end_at=? WHERE id=?",
          )
          .bind(other.start_min, other.start_at, other.end_at, b.id),
      ]),
    /slot_taken/,
  );
  assert.equal(await auditCount(), before);
  assert.equal(
    (
      await db
        .prepare("SELECT start_min FROM bookings WHERE id=?")
        .bind(b.id)
        .first()
    ).start_min,
    540,
  );
  // Dated leave must also block INSERT and reschedule inside the database itself.
  const leave = await api(`/staff/${b.staff_id}/days-off`, "POST", {
    date,
    reason: "Write-time leave test",
  });
  assert.equal(leave.status, 201);
  const leaveBlocked = {
    ...duplicate,
    id: crypto.randomUUID(),
    request_id: crypto.randomUUID(),
    sequence: 10003,
    start_min: 630,
    start_at: b.start_at + 90 * 60000,
    end_at: b.end_at + 90 * 60000,
  };
  await assert.rejects(
    () =>
      db
        .prepare(
          `INSERT INTO bookings (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
        )
        .bind(...columns.map((k) => leaveBlocked[k]))
        .run(),
    /staff_day_off/,
  );
  await assert.rejects(
    () =>
      db
        .prepare(
          "UPDATE bookings SET start_min=?,start_at=?,end_at=? WHERE id=?",
        )
        .bind(630, leaveBlocked.start_at, leaveBlocked.end_at, b.id)
        .run(),
    /staff_day_off/,
  );
  assert.equal(
    (await api(`/staff/${b.staff_id}/days-off/${leave.body.id}`, "DELETE"))
      .status,
    200,
  );
  // Closure is checked again inside INSERT even if an earlier availability read was valid.
  await api("/holidays", "POST", { date, label: "Write-time closure test" });
  const later = {
    ...duplicate,
    id: crypto.randomUUID(),
    request_id: crypto.randomUUID(),
    sequence: 10001,
    start_min: 630,
    start_at: b.start_at + 90 * 60000,
    end_at: b.end_at + 90 * 60000,
  };
  await assert.rejects(
    () =>
      db
        .prepare(
          `INSERT INTO bookings (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
        )
        .bind(...columns.map((k) => later[k]))
        .run(),
    /shop_closed/,
  );
  // Seed a clearly fictional historical appointment to test elapsed grace using real server time.
  const pastDate = new Date(Date.parse(date + "T12:00:00Z") - 14 * 86400000)
    .toISOString()
    .slice(0, 10);
  const past = {
    ...b,
    id: crypto.randomUUID(),
    request_id: crypto.randomUUID(),
    sequence: 10002,
    date: pastDate,
    start_at: b.start_at - 14 * 86400000,
    end_at: b.end_at - 14 * 86400000,
  };
  await db
    .prepare(
      `INSERT INTO bookings (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    )
    .bind(...columns.map((k) => past[k]))
    .run();
  assert.equal(
    (
      await api(`/bookings/${past.id}/status`, "POST", {
        status: "NO_SHOW",
        version: 0,
        reason: "Fictional past appointment grace test",
      })
    ).status,
    200,
  );
  assert.equal(
    (await api(`/bookings/${past.id}`)).body.booking.status,
    "NO_SHOW",
  );
  // Bypass the API after a quote change: the database itself must still reject it.
  await db
    .prepare("UPDATE services SET version=version+1 WHERE id=? AND shop_id=?")
    .bind(b.service_id, w.shop.id)
    .run();
  await assert.rejects(
    () =>
      db
        .prepare(
          `INSERT INTO bookings (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
        )
        .bind(...columns.map((k) => later[k]))
        .run(),
    /quote_changed/,
  );
  console.log(
    "PASS: direct D1 overlap/quote rejection, immutable snapshots/history, atomic batch rollback, write-time closure and elapsed no-show grace.",
  );
} finally {
  await platform.dispose();
}
