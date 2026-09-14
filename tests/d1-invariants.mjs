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
  const closure = await api("/holidays", "POST", {
    date,
    label: "Write-time closure test",
  });
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
  // Isolate quote validation from closure validation; SQLite trigger order is not a contract.
  assert.equal(
    (await api(`/holidays/${closure.body.id}`, "DELETE")).status,
    200,
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
  // Exercise catalogue and dated-hour guards through raw D1 writes, not API pre-checks.
  const addonResponse = await api("/addons", "POST", {
    name: "Invariant towel",
    price_pence: 650,
    duration_min: 20,
    active: 1,
    service_ids: [b.service_id],
  });
  assert.equal(addonResponse.status, 201);
  const addonId = addonResponse.body.id,
    secondStaff = w.staff[1].id;
  assert.equal(
    (
      await api(`/staff/${secondStaff}/services/${b.service_id}`, "PUT", {
        enabled: 1,
        price_pence: 3300,
        duration_min: 25,
        version: 0,
      })
    ).status,
    200,
  );
  const q = (
    await api(
      "/availability?" +
        new URLSearchParams({
          date,
          staff_id: secondStaff,
          service_id: b.service_id,
          addon_ids: addonId,
        }),
    )
  ).body;
  const combined = await api("/bookings", "POST", {
    ...body,
    request_id: crypto.randomUUID(),
    staff_id: secondStaff,
    addon_ids: [addonId],
    quote: q.quote,
  });
  assert.equal(combined.status, 201);
  const itemBooking = combined.body.booking;
  const candidate = {
    ...itemBooking,
    id: crypto.randomUUID(),
    request_id: crypto.randomUUID(),
    sequence: 10010,
    start_min: 630,
    start_at: itemBooking.start_at + 90 * 60000,
    end_at: itemBooking.end_at + 90 * 60000,
  };
  const rawInsert = (value) =>
    db
      .prepare(
        `INSERT INTO bookings (${Object.keys(value).join(",")}) VALUES (${Object.keys(
          value,
        )
          .map(() => "?")
          .join(",")})`,
      )
      .bind(...Object.values(value))
      .run();
  await assert.rejects(
    () => rawInsert({ ...candidate, price_pence: 1 }),
    /invalid_booking_items/,
  );
  await assert.rejects(
    () =>
      db
        .prepare("UPDATE bookings SET items_json='[]' WHERE id=?")
        .bind(itemBooking.id)
        .run(),
    /booking_snapshot_immutable/,
  );
  await db
    .prepare("UPDATE addons SET price_pence=999 WHERE shop_id=? AND id=?")
    .bind(w.shop.id, addonId)
    .run();
  await assert.rejects(() => rawInsert(candidate), /addon_unavailable/);
  await db
    .prepare("UPDATE addons SET price_pence=650 WHERE shop_id=? AND id=?")
    .bind(w.shop.id, addonId)
    .run();
  const override = await api(`/staff/${secondStaff}/overrides`, "POST", {
    date,
    enabled: 1,
    starts: 720,
    ends: 1020,
    break_start: 720,
    break_end: 720,
    reason: "Raw write partial shift test",
  });
  assert.equal(override.status, 201);
  await assert.rejects(() => rawInsert(candidate), /outside_hours/);
  await assert.rejects(
    () =>
      db
        .prepare(
          "UPDATE bookings SET start_min=?,start_at=?,end_at=? WHERE id=?",
        )
        .bind(
          candidate.start_min,
          candidate.start_at,
          candidate.end_at,
          itemBooking.id,
        )
        .run(),
    /outside_hours/,
  );
  assert.equal(
    (await api(`/staff/${secondStaff}/overrides/${override.body.id}`, "DELETE"))
      .status,
    200,
  );
  await db
    .prepare(
      "UPDATE staff_service_rules SET enabled=0 WHERE shop_id=? AND staff_id=? AND service_id=?",
    )
    .bind(w.shop.id, secondStaff, b.service_id)
    .run();
  await assert.rejects(() => rawInsert(candidate), /service_ineligible/);
  assert.equal(
    (
      await db
        .prepare("SELECT start_min FROM bookings WHERE id=?")
        .bind(itemBooking.id)
        .first()
    ).start_min,
    540,
  );
  console.log(
    "PASS: direct D1 overlap, quote/items, addon/rule eligibility, dated hours, immutable snapshots, rollback, leave/closure and no-show guards.",
  );
  // Account assertions must abort on the FIRST conflict, not a sentinel's later duplicate.
  const address = `${crypto.randomUUID()}@example.test`;
  assert.equal(
    (
      await api("/auth/register", "POST", {
        name: "D1 fictional owner",
        email: address,
        password: "Unique local invariant password!",
      })
    ).status,
    201,
  );
  const account = (await api("/workspace")).body.account;
  const oldUser = await db
    .prepare("SELECT * FROM app_users WHERE id=?")
    .bind(account.user_id)
    .first();
  const oldSessions = await db
    .prepare(
      "SELECT * FROM app_sessions WHERE membership_id=? ORDER BY token_hash",
    )
    .bind(account.id)
    .all();
  const oldAudit = await auditCount();
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(
      () =>
        db.batch([
          db
            .prepare(
              "UPDATE app_users SET password_hash='incorrect' WHERE id=? AND password_hash='stale' ",
            )
            .bind(account.user_id),
          db.prepare("INSERT INTO account_assertions(ok) VALUES(changes())"),
          db.prepare("DELETE FROM account_assertions"),
          db
            .prepare("DELETE FROM app_sessions WHERE membership_id=?")
            .bind(account.id),
        ]),
      /account_changed/,
    );
  }
  assert.deepEqual(
    await db
      .prepare("SELECT * FROM app_users WHERE id=?")
      .bind(account.user_id)
      .first(),
    oldUser,
  );
  assert.deepEqual(
    (
      await db
        .prepare(
          "SELECT * FROM app_sessions WHERE membership_id=? ORDER BY token_hash",
        )
        .bind(account.id)
        .all()
    ).results,
    oldSessions.results,
  );
  assert.equal(await auditCount(), oldAudit);
  await assert.rejects(
    () =>
      db
        .prepare("UPDATE app_memberships SET role='MANAGER' WHERE id=?")
        .bind(account.id)
        .run(),
    /owner_protected/,
  );
  await assert.rejects(
    () =>
      db
        .prepare("DELETE FROM app_memberships WHERE id=?")
        .bind(account.id)
        .run(),
    /owner_protected/,
  );
  // Simulate the precise stale read: token A was read, then revoked and replaced by B for SAME email/role/staff.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("src/server/accounts.ts", "utf8");
  const memberSql = source.match(
    /"(INSERT INTO app_memberships\(id,shop_id,user_id,role,staff_id\) SELECT [^"]+)"/,
  )[1];
  const target = `${crypto.randomUUID()}@example.test`;
  const first = await api("/auth/invites", "POST", {
    email: target,
    staff_id: w.staff[0].id,
    role: "BARBER",
  });
  const replacement = await api("/auth/invites", "POST", {
    email: target,
    staff_id: w.staff[0].id,
    role: "BARBER",
  });
  assert.equal(first.status, 201);
  assert.equal(replacement.status, 201);
  const stale = await db
    .prepare("SELECT * FROM staff_invitations WHERE id=?")
    .bind(first.body.id)
    .first();
  const userId = crypto.randomUUID(),
    memberId = crypto.randomUUID();
  const insertUser = () =>
    db
      .prepare(
        "INSERT INTO app_users(id,email,name,password_hash,password_salt,created_at) VALUES(?,?,'Fictional staff','test-only','test-only',?)",
      )
      .bind(userId, target, Date.now());
  await assert.rejects(
    () =>
      db.batch([
        insertUser(),
        db
          .prepare(memberSql)
          .bind(
            memberId,
            userId,
            stale.id,
            stale.token_hash,
            target,
            Date.now(),
          ),
        db.prepare("INSERT INTO account_assertions(ok) VALUES(changes())"),
        db.prepare("DELETE FROM account_assertions"),
      ]),
    /account_changed/,
  );
  assert.equal(
    await db
      .prepare("SELECT id FROM app_users WHERE id=?")
      .bind(userId)
      .first(),
    null,
  );
  assert.equal(
    await db
      .prepare("SELECT id FROM app_memberships WHERE id=?")
      .bind(memberId)
      .first(),
    null,
  );
  // Expiry also fails closed even when the invite had passed a prior read.
  await db
    .prepare("UPDATE staff_invitations SET expires_at=? WHERE id=?")
    .bind(Date.now() - 1000, replacement.body.id)
    .run();
  assert.equal(
    (
      await api("/auth/accept", "POST", {
        token: replacement.body.token,
        email: target,
        name: "Fictional staff",
        password: "Unique local invariant password!",
      })
    ).status,
    400,
  );
  assert.equal(
    (await db.prepare("SELECT COUNT(*) AS n FROM account_assertions").first())
      .n,
    0,
  );
  console.log(
    "PASS: direct D1 first/repeated optimistic rollback, owner protection, exact-token stale replacement and expiry guards.",
  );
} finally {
  await platform.dispose();
}
