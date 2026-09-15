// Standard demo shop: one click, fixed credentials, realistic fictional history.
// Local sandbox only. Rebuilding removes the previous demo shop's rows entirely
// (bookings/audit rows are normally undeletable, so the demo shop is re-created
// under a fresh id and the old one is renamed as retired rather than deleted).
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "./accounts";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { digest, passwordHash, newSession, cookies, readInput } from "./accounts";
import { localInstant, shopToday } from "./domain";

type Ctx = Context<AppEnv>;
export const DEMO_OWNER_EMAIL = "owner@demo.test";
export const DEMO_BARBER_EMAIL = "jay@demo.test";
export const DEMO_PASSWORD = "Demo1234!";
export const DEMO_SLUG = "demo";
const uid = () => crypto.randomUUID();

type Seed = {
  shopId: string;
  ownerUser: string;
  ownerMembership: string;
  barberUser: string;
  barberMembership: string;
};

const FIRST = ["Ada", "Tom", "Sam", "Priya", "Leo", "Maya", "Kofi", "Ella", "Noah", "Zara", "Ibrahim", "Grace", "Oscar", "Amara", "Finn", "Nia", "Hugo", "Layla", "Theo", "Rosa", "Jamal", "Isla", "Arjun", "Freya"];
const LAST = ["Lovelace", "Kerr", "Adeyemi", "Nair", "Marsh", "Okafor", "Mensah", "Byrne", "Hart", "Malik", "Osei", "Quinn", "Reid", "Silva", "Walsh", "Young", "Doyle", "Khan", "Baptiste", "Costa"];

// Deterministic pseudo-random so the demo looks the same on every rebuild.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export async function demoShopId(db: D1Database) {
  const row = await db
    .prepare(
      "SELECT o.shop_id FROM shop_owners o JOIN app_users u ON u.id=o.user_id WHERE u.email=?",
    )
    .bind(DEMO_OWNER_EMAIL)
    .first<{ shop_id: string }>();
  return row?.shop_id ?? null;
}

async function retirePrevious(db: D1Database) {
  const previous = await demoShopId(db);
  if (!previous) return;
  const users = await db
    .prepare("SELECT id FROM app_users WHERE email IN (?,?)")
    .bind(DEMO_OWNER_EMAIL, DEMO_BARBER_EMAIL)
    .all<{ id: string }>();
  const ids = users.results.map((u) => u.id);
  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM app_sessions WHERE membership_id IN (SELECT id FROM app_memberships WHERE shop_id=?)").bind(previous),
    db.prepare("DELETE FROM staff_invitations WHERE shop_id=?").bind(previous),
    db.prepare("DELETE FROM sandbox_sessions WHERE shop_id=?").bind(previous),
    db.prepare("DELETE FROM booking_manage_tokens WHERE shop_id=?").bind(previous),
    db.prepare("DELETE FROM waitlist_entries WHERE shop_id=?").bind(previous),
    // Owner memberships are delete-protected; release the shop by retiring it instead.
    db.prepare("UPDATE shops SET slug=NULL, online_booking=0, name=name||' (retired demo)', version=version+1 WHERE id=?").bind(previous),
    // Non-owner memberships (the barber) can go; owner membership stays with the retired shop.
    db.prepare("DELETE FROM app_memberships WHERE shop_id=? AND role<>'OWNER'").bind(previous),
  ];
  // Free the fixed emails: rename the retired owner/barber users.
  for (const id of ids)
    statements.push(
      db.prepare("UPDATE app_users SET email=? WHERE id=?").bind(`retired-${id.slice(0, 8)}@demo.retired`, id),
    );
  statements.push(db.prepare("DELETE FROM shop_owners WHERE shop_id=?").bind(previous));
  await db.batch(statements);
}

export type DemoOptions = {
  // Isolated fixture: same seed content under a private slug/emails. Never touches the shared
  // demo shop, so parallel test workers can each build one without racing `retirePrevious`.
  isolated?: boolean;
};
export async function buildDemo(c: Ctx, options: DemoOptions = {}): Promise<Seed & { slug: string; ownerEmail: string; barberEmail: string }> {
  const db = c.env.DB;
  const tag = options.isolated ? `-${crypto.randomUUID().slice(0, 8)}` : "";
  const slug = options.isolated ? `demo${tag}` : DEMO_SLUG;
  const ownerEmail = options.isolated ? `owner${tag}@demo.test` : DEMO_OWNER_EMAIL;
  const barberEmail = options.isolated ? `jay${tag}@demo.test` : DEMO_BARBER_EMAIL;
  const shopName = options.isolated ? `Demo Barbershop ${tag.slice(1)}` : "Demo Barbershop";
  if (!options.isolated) await retirePrevious(db);
  const now = Date.now();
  const today = shopToday("Europe/London", now);
  const random = rng(20260914);
  const shopId = uid();
  const ownerUser = uid(), ownerMembership = uid(), barberUser = uid(), barberMembership = uid();
  const salt = uid() + uid();
  const encoded = await passwordHash(DEMO_PASSWORD, salt);
  const staff = [
    { id: uid(), name: "Jay Carter", role: "Senior barber", hours: [1, 2, 3, 4, 5, 6], colour: "sage", title: "Senior barber & owner's right hand", bio: "Twelve years behind the chair. Precision fades and classic scissor work; loves a proper consultation.", skills: ["Skin fades", "Scissor work", "Kids"], instagram: "jaycuts", commission: 60, pay: { model: "COMMISSION", period: "WEEKLY", tiers: [{ from_pence: 0, pct: 55 }, { from_pence: 100000, pct: 65 }] } },
    { id: uid(), name: "Marcus Reed", role: "Barber", hours: [1, 2, 3, 4, 5], colour: "sand", title: "Barber", bio: "Fast, tidy and great with regulars who know exactly what they want.", skills: ["Skin fades", "Afro hair"], instagram: "", commission: 50, pay: { model: "CHAIR_RENT", period: "WEEKLY", rent: 18000 } },
    { id: uid(), name: "Dani Okoro", role: "Barber & beard specialist", hours: [2, 3, 4, 5, 6], colour: "blue", title: "Beard specialist", bio: "Hot towel shaves, beard sculpting and grey blending. Book the full works for the complete reset.", skills: ["Beards", "Hot towel shaves", "Colour"], instagram: "dani.beards", commission: 55, pay: { model: "HYBRID", period: "MONTHLY", base: 120000, threshold: 200000 } },
  ];
  const services = [
    { id: uid(), name: "Signature cut", category: "Hair", duration: 30, price: 2800, colour: "sage", popular: 1, description: "Consultation, clipper or scissor cut, sharp neckline and a styled finish." },
    { id: uid(), name: "Skin fade", category: "Hair", duration: 45, price: 3200, colour: "blue", popular: 1, description: "Blended to the skin with a razor edge. Any length on top." },
    { id: uid(), name: "Scissor cut", category: "Hair", duration: 40, price: 3000, colour: "sand", popular: 0, description: "Scissor-only cut for longer styles and texture." },
    { id: uid(), name: "Kids cut (under 12)", category: "Hair", duration: 30, price: 1800, colour: "clay", popular: 0, description: "Patient, quick and tidy. Parents welcome to stay." },
    { id: uid(), name: "Beard trim & shape", category: "Beard", duration: 20, price: 1500, colour: "plum", popular: 0, description: "Shape, line-up and oil finish." },
    { id: uid(), name: "Hot towel shave", category: "Beard", duration: 30, price: 2500, colour: "slate", popular: 0, description: "Traditional straight-razor shave with hot towels and balm." },
    { id: uid(), name: "Cut & beard", category: "Combos", duration: 60, price: 4200, colour: "sage", popular: 1, description: "Signature cut plus beard trim & shape." },
    { id: uid(), name: "The full works", category: "Combos", duration: 75, price: 5500, colour: "blue", popular: 0, description: "Cut, hot towel shave, eyebrow tidy and a head massage." },
  ];
  const addons = [
    { id: uid(), name: "Hot towel finish", duration: 5, price: 500, services: [0, 1, 2, 6] },
    { id: uid(), name: "Grey blending", duration: 15, price: 1200, services: [0, 1, 2] },
    { id: uid(), name: "Eyebrow tidy", duration: 5, price: 400, services: [0, 1, 2, 4, 6, 7] },
    { id: uid(), name: "Nose wax", duration: 5, price: 600, services: [4, 5, 6, 7] },
  ];
  const s: D1PreparedStatement[] = [
    db.prepare(
      "INSERT INTO shops(id,name,address,created_at,slug,online_booking,lead_time_min,booking_window_days) VALUES(?,?,?,?,?,1,60,42)",
    ).bind(shopId, shopName, "12 Market Row, London E8 4QJ", now, slug),
    db.prepare("INSERT INTO app_users(id,email,name,password_hash,password_salt,created_at) VALUES(?,?,?,?,?,?)")
      .bind(ownerUser, ownerEmail, "Demo Owner", encoded, salt, now),
    db.prepare("INSERT INTO shop_owners(shop_id,user_id) VALUES(?,?)").bind(shopId, ownerUser),
    db.prepare("INSERT INTO app_memberships(id,shop_id,user_id,role) VALUES(?,?,?,'OWNER')").bind(ownerMembership, shopId, ownerUser),
  ];
  for (const b of staff) {
    s.push(
      db.prepare("INSERT INTO staff(id,shop_id,name,role,colour,title,bio,skills,instagram,start_date,sort_order,commission_pct,pay_model,pay_period,commission_tiers,rent_pence,base_pence,commission_threshold_pence,employment) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(b.id, shopId, b.name, b.role, b.colour, b.title, b.bio, JSON.stringify(b.skills), b.instagram, "2024-03-01", staff.indexOf(b), b.commission, b.pay.model, b.pay.period, JSON.stringify("tiers" in b.pay ? b.pay.tiers : []), "rent" in b.pay ? b.pay.rent : 0, "base" in b.pay ? b.pay.base : 0, "threshold" in b.pay ? b.pay.threshold : 0, b.pay.model === "HYBRID" ? "EMPLOYED" : "SELF_EMPLOYED"),
    );
    for (let day = 0; day < 7; day++)
      s.push(
        db.prepare(
          "INSERT INTO staff_hours(shop_id,staff_id,weekday,enabled,starts,ends,break_start,break_end) VALUES(?,?,?,?,?,?,?,?)",
        ).bind(shopId, b.id, day, b.hours.includes(day) ? 1 : 0, day === 6 ? 540 : 570, day === 6 ? 960 : 1080, 780, 810),
      );
  }
  for (const sv of services)
    s.push(
      db.prepare("INSERT INTO services(id,shop_id,name,category,duration_min,price_pence,colour,popular,description,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .bind(sv.id, shopId, sv.name, sv.category, sv.duration, sv.price, sv.colour, sv.popular, sv.description, services.indexOf(sv)),
    );
  for (const a of addons) {
    s.push(db.prepare("INSERT INTO addons(id,shop_id,name,duration_min,price_pence) VALUES(?,?,?,?,?)").bind(a.id, shopId, a.name, a.duration, a.price));
    for (const i of a.services)
      s.push(db.prepare("INSERT INTO addon_services(shop_id,addon_id,service_id) VALUES(?,?,?)").bind(shopId, a.id, services[i].id));
  }
  // Marcus doesn't do shaves; Dani charges more for the full works and is quicker on beards.
  s.push(db.prepare("INSERT INTO staff_service_rules(shop_id,staff_id,service_id,enabled) VALUES(?,?,?,0)").bind(shopId, staff[1].id, services[5].id));
  s.push(db.prepare("INSERT INTO staff_service_rules(shop_id,staff_id,service_id,enabled,price_pence) VALUES(?,?,?,1,6000)").bind(shopId, staff[2].id, services[7].id));
  s.push(db.prepare("INSERT INTO staff_service_rules(shop_id,staff_id,service_id,enabled,duration_min) VALUES(?,?,?,1,15)").bind(shopId, staff[2].id, services[4].id));
  // Barber account for Jay via a pre-accepted invitation (trigger requires one).
  const inviteId = uid();
  s.push(
    db.prepare("INSERT INTO app_users(id,email,name,password_hash,password_salt,created_at) VALUES(?,?,?,?,?,?)")
      .bind(barberUser, barberEmail, "Jay Carter", encoded, salt, now),
    db.prepare(
      "INSERT INTO staff_invitations(id,shop_id,staff_id,email,role,token_hash,expires_at,created_at) VALUES(?,?,?,?,'BARBER',?,?,?)",
    ).bind(inviteId, shopId, staff[0].id, barberEmail, await digest(uid()), now + 86400000, now),
    db.prepare("INSERT INTO app_memberships(id,shop_id,user_id,role,staff_id) VALUES(?,?,?,'BARBER',?)").bind(barberMembership, shopId, barberUser, staff[0].id),
    db.prepare("UPDATE staff_invitations SET accepted_at=? WHERE id=?").bind(now, inviteId),
  );
  await db.batch(s);

  // Customers: ~40 fictional regulars with a favourite barber and service.
  const customers = Array.from({ length: 40 }, (_, i) => ({
    name: `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`,
    phone: `0770090${String(1000 + i).slice(-4)}`,
    email: i % 3 === 0 ? `${FIRST[i % FIRST.length].toLowerCase()}${i}@example.test` : "",
    barber: staff[i % 3 === 0 ? 0 : i % 3 === 1 ? 1 : 2],
    service: services[[0, 1, 6, 0, 2, 4, 7, 1, 0, 5][i % 10]],
    cadence: [2, 3, 4, 6][i % 4],
    offset: i % 14,
  }));
  // Bookings: walk history from -70 days to +14 days on each customer's cadence.
  const bookings: D1PreparedStatement[] = [];
  const taken = new Map<string, { start: number; end: number }[]>();
  let seq = 0;
  const day = (off: number) => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + off);
    return d.toISOString().slice(0, 10);
  };
  const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
  const push = (
    cust: (typeof customers)[number],
    barber: (typeof staff)[number],
    service: (typeof services)[number],
    date: string,
    startMin: number,
    status: string,
    channel: "OWNER" | "ONLINE",
    seriesId: string | null = null,
  ) => {
    const wd = weekdayOf(date);
    if (!barber.hours.includes(wd)) return false;
    const opens = wd === 6 ? 540 : 570, closes = wd === 6 ? 960 : 1080;
    const rule = barber === staff[2] && service === services[7] ? { price: 6000, duration: 75 } : barber === staff[2] && service === services[4] ? { price: 1500, duration: 15 } : null;
    if (barber === staff[1] && service === services[5]) return false;
    const price = rule?.price ?? service.price, duration = rule?.duration ?? service.duration;
    if (startMin < opens || startMin + duration + 10 > closes) return false;
    if (startMin < 810 && startMin + duration + 10 > 780) return false;
    const start = localInstant(date, startMin, "Europe/London");
    if (!start) return false;
    const end = start + duration * 60000;
    const key = barber.id;
    const list = taken.get(key) || [];
    if (["CONFIRMED", "CHECKED_IN", "IN_SERVICE", "COMPLETED"].includes(status) && list.some((t) => t.start < end + 600000 && start < t.end + 600000)) return false;
    list.push({ start, end });
    taken.set(key, list);
    const id = uid();
    seq++;
    const items = JSON.stringify([{ kind: "SERVICE", id: service.id, name: service.name, price_pence: price, duration_min: duration }]);
    bookings.push(
      db.prepare(
        `INSERT INTO bookings(id,shop_id,sequence,request_id,request_hash,staff_id,service_id,customer_name,phone,notes,date,start_min,start_at,end_at,duration_min,service_name,price_pence,deposit_policy_pence,cancel_hours_snapshot,source,status,created_at,updated_at,quoted_service_version,quoted_shop_version,items_json,channel,email,series_id)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,?,?,?)`,
      ).bind(
        id, shopId, seq, uid(), "demo", barber.id, service.id, cust.name, cust.phone,
        status === "NO_SHOW" ? "" : random() < 0.2 ? "Prefers number 2 on the sides." : "",
        date, startMin, start, end, duration, service.name, price, Math.min(500, price), 24,
        channel === "ONLINE" || random() < 0.85 ? "TEST_BOOKING" : "WALK_IN",
        status, start - 3 * 86400000, start - 3 * 86400000, items, channel, cust.email, seriesId,
      ),
    );
    bookings.push(
      db.prepare(
        "INSERT INTO audit_events(id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)",
      ).bind(uid(), shopId, "booking", id, "BOOKING_CREATED", channel === "ONLINE" ? "customer:online" : "demo-seed", "Demo history.", start - 3 * 86400000),
    );
    if (status !== "CONFIRMED")
      bookings.push(
        db.prepare(
          "INSERT INTO audit_events(id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)",
        ).bind(uid(), shopId, "booking", id, `STATUS_${status}`, "demo-seed", status === "CANCELLED" ? "Customer cancelled." : status === "NO_SHOW" ? "Did not arrive." : "", end),
      );
    // Completed visits were paid at the chair: one ledger row each (card-heavy, some cash, occasional tip).
    if (status === "COMPLETED") {
      const r = random();
      const method = r < 0.62 ? "CARD" : r < 0.9 ? "CASH" : r < 0.97 ? "TRANSFER" : "VOUCHER";
      const tip = random() < 0.35 ? [200, 300, 500][Math.floor(random() * 3)] : 0;
      bookings.push(
        db.prepare(
          "INSERT INTO payments(id,shop_id,booking_id,staff_id,customer_id,date,method,service_pence,tip_pence,discount_pence,commission_pct,note,recorded_by,created_at) VALUES(?,?,?,?,NULL,?,?,?,?,0,?,'',?,?)",
        ).bind(uid(), shopId, id, barber.id, date, method, price, tip, barber.commission, "demo-seed", end + 120000),
      );
    }
    return true;
  };
  const starts = [570, 600, 630, 660, 690, 720, 750, 810, 840, 870, 900, 930, 960, 990, 1020];
  for (const cust of customers) {
    let off = -70 + cust.offset;
    while (off <= 14) {
      const date = day(off);
      const startMin = starts[Math.floor(random() * starts.length)];
      const past = off < 0;
      const r = random();
      const status = past ? (r < 0.08 ? "NO_SHOW" : r < 0.16 ? "CANCELLED" : "COMPLETED") : r < 0.05 ? "CANCELLED" : "CONFIRMED";
      const barber = random() < 0.85 ? cust.barber : staff[Math.floor(random() * 3)];
      const service = random() < 0.8 ? cust.service : services[Math.floor(random() * services.length)];
      const channel: "OWNER" | "ONLINE" = random() < 0.4 ? "ONLINE" : "OWNER";
      // Try a few times to find a free slot on that day, otherwise skip the visit.
      for (let attempt = 0; attempt < 6; attempt++) {
        const candidate = attempt === 0 ? startMin : starts[Math.floor(random() * starts.length)];
        if (push(cust, barber, service, date, candidate, status, channel)) break;
      }
      off += cust.cadence * 7;
    }
  }
  // A standing booking: Ada, every 2 weeks with Jay at 10:00, next 5 fortnights.
  const seriesId = uid();
  bookings.unshift(
    db.prepare(
      "INSERT INTO booking_series(id,shop_id,staff_id,service_id,customer_name,phone,interval_weeks,start_date,start_min,occurrences,created_at) VALUES(?,?,?,?,?,?,2,?,600,5,?)",
    ).bind(seriesId, shopId, staff[0].id, services[0].id, customers[0].name, customers[0].phone, day(3), now),
  );
  for (let i = 0; i < 5; i++) {
    let d = 3 + i * 14;
    for (let tries = 0; tries < 3; tries++) {
      if (push(customers[0], staff[0], services[0], day(d), 600, "CONFIRMED", "OWNER", seriesId)) break;
      d += 1;
    }
  }
  // Insert in chunks; D1 batches are transactional per call.
  for (let i = 0; i < bookings.length; i += 80) await db.batch(bookings.slice(i, i + 80));
  await db.batch([
    db.prepare(
      "INSERT INTO waitlist_entries(id,shop_id,staff_id,service_id,customer_name,phone,email,date,daypart,notes,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'OPEN',?,?)",
    ).bind(uid(), shopId, staff[0].id, services[1].id, customers[5].name, customers[5].phone, "", day(2), "AFTERNOON", "Any time after 2pm works.", now, now),
    db.prepare(
      "INSERT INTO waitlist_entries(id,shop_id,staff_id,service_id,customer_name,phone,email,date,daypart,notes,status,created_at,updated_at) VALUES(?,?,NULL,?,?,?,?,?,?,?,'OPEN',?,?)",
    ).bind(uid(), shopId, services[6].id, customers[9].name, customers[9].phone, customers[9].email, day(1), "MORNING", "", now, now),
    db.prepare("INSERT INTO staff_days_off(id,shop_id,staff_id,date,reason,created_at) VALUES(?,?,?,?,?,?)").bind(uid(), shopId, staff[1].id, day(5), "Annual leave", now),
    db.prepare(
      "INSERT INTO audit_events(id,shop_id,entity_type,entity_id,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)",
    ).bind(uid(), shopId, "shop", shopId, "DEMO_SHOP_BUILT", "demo-seed", `${seq} fictional appointments, 3 barbers, ${services.length} services. No payments or messages.`, now),
  ]);
  return { shopId, ownerUser, ownerMembership, barberUser, barberMembership, slug, ownerEmail, barberEmail };
}

// POST /auth/demo — build (or rebuild) the demo shop and sign in as its owner.
export async function demoRoute(c: Ctx) {
  const body = await readInput(
    c,
    z
      .object({
        rebuild: z.boolean().default(false),
        as: z.enum(["owner", "barber"]).default("owner"),
        // fixture=true builds a private, fully seeded copy for automated tests; the shared demo is untouched.
        fixture: z.boolean().default(false),
      })
      .strict(),
  );
  let shop: string | null;
  let email: string;
  let slug = DEMO_SLUG;
  if (body.fixture) {
    const seed = await buildDemo(c, { isolated: true });
    shop = seed.shopId;
    slug = seed.slug;
    email = body.as === "barber" ? seed.barberEmail : seed.ownerEmail;
  } else {
    shop = await demoShopId(c.env.DB);
    if (!shop || body.rebuild) {
      await buildDemo(c);
      shop = (await demoShopId(c.env.DB))!;
    }
    email = body.as === "barber" ? DEMO_BARBER_EMAIL : DEMO_OWNER_EMAIL;
  }
  const m = await c.env.DB.prepare(
    "SELECT m.id,m.version,u.password_hash FROM app_memberships m JOIN app_users u ON u.id=m.user_id WHERE m.shop_id=? AND u.email=? AND m.active=1",
  )
    .bind(shop, email)
    .first<{ id: string; version: number; password_hash: string }>();
  if (!m) return c.json({ error: "demo_unavailable", message: "Demo account missing; rebuild it." }, 409);
  const session = await newSession(c, m.id, m.password_hash, m.version);
  await c.env.DB.batch([
    session.write,
    c.env.DB.prepare("INSERT INTO account_assertions(ok) VALUES(changes())"),
    c.env.DB.prepare("DELETE FROM account_assertions"),
  ]);
  cookies(c, session.raw);
  return c.json({ ok: true, shop_id: shop, email, password: DEMO_PASSWORD, slug }, 201);
}
