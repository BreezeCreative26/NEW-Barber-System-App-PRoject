// Customer CSV import: column detection, UK mobile normalisation, dedupe against the directory,
// preview-before-write, fill-blanks-only updates, role boundary, and the browser flow.
import { test, expect, request } from "@playwright/test";
import { base, origin, openFixtureShop, section } from "./fixture";
import { newShop } from "./shop";

const CSV = [
  "Client Name,Mobile,E-mail,Notes,Tags,DOB,Marketing",
  "Ada Lovelace,07700 900101,ada@example.test,Likes a skin fade,vip;regular,10/12/1985,yes",
  '"Babbage, Charles",+44 7700 900102,,,,,no',
  "Grace Hopper,447700900103,grace@example.test,,,1906-12-09,",
  "No Phone Person,,nophone@example.test,,,,",
  "Bad Phone,0207 946 0000,,,,,",
  "Ada Again,07700900101,dupe@example.test,,,,",
].join("\n");

test("import: preview detects columns, normalises mobiles, flags invalid and duplicates; commit creates once; second import fills blanks only", async () => {
  const { r } = await newShop("Import test shop");
  // Preview
  let res = await r.post(base + "/customers/import/preview", { data: { csv: CSV } });
  expect(res.status(), await res.text()).toBe(200);
  const p = await res.json();
  expect(p.mapping.name).toBe("Client Name");
  expect(p.mapping.phone).toBe("Mobile");
  expect(p.mapping.email).toBe("E-mail");
  expect(p.mapping.birthday).toBe("DOB");
  expect(p.counts).toMatchObject({ create: 3, update: 0, skip: 1, invalid: 2, total: 6 });
  const byLine = Object.fromEntries(p.rows.map((x: { line: number }) => [x.line, x]));
  expect(byLine[2]).toMatchObject({ name: "Ada Lovelace", phone: "07700900101", email: "ada@example.test", tags: ["vip", "regular"], birthday: "1985-12-10", marketing_opt_in: 1, action: "create" });
  expect(byLine[3]).toMatchObject({ name: "Babbage, Charles", phone: "07700900102", action: "create" });
  expect(byLine[4]).toMatchObject({ phone: "07700900103", birthday: "1906-12-09", action: "create" });
  expect(byLine[5]).toMatchObject({ action: "invalid", reason: "No mobile number" });
  expect(byLine[6]).toMatchObject({ action: "invalid", reason: "Not a UK mobile" });
  expect(byLine[7]).toMatchObject({ action: "skip", reason: "Duplicate mobile in this file" });
  // Nothing written by preview.
  let list = await (await r.get(base + "/customers?q=&filter=all&sort=recent&limit=50")).json();
  expect(list.customers.find((c: { phone: string }) => c.phone === "07700900101")).toBeUndefined();

  // Commit
  res = await r.post(base + "/customers/import", { data: { csv: CSV } });
  expect(res.status(), await res.text()).toBe(201);
  expect(await res.json()).toMatchObject({ created: 3, updated: 0, skipped: 1, invalid: 2, total: 6 });
  list = await (await r.get(base + "/customers?q=&filter=all&sort=recent&limit=50")).json();
  const ada = list.customers.find((c: { phone: string }) => c.phone === "07700900101");
  expect(ada).toMatchObject({ name: "Ada Lovelace", email: "ada@example.test" });
  const charles = list.customers.find((c: { phone: string }) => c.phone === "07700900102");
  expect(charles.email).toBe("");

  // Second file: Charles now has an email and a note; Ada's email must NOT change.
  const CSV2 = ["name,phone,email,notes", "Charles B,07700900102,charles@example.test,Prefers Saturdays", "Ada L,07700900101,other@example.test,"].join("\n");
  const p2 = await (await r.post(base + "/customers/import/preview", { data: { csv: CSV2 } })).json();
  expect(p2.counts).toMatchObject({ create: 0, update: 1, skip: 1, invalid: 0 });
  expect(p2.rows.find((x: { phone: string }) => x.phone === "07700900101").reason).toMatch(/Already here as Ada Lovelace/);
  res = await r.post(base + "/customers/import", { data: { csv: CSV2 } });
  expect(res.status(), await res.text()).toBe(201);
  expect(await res.json()).toMatchObject({ created: 0, updated: 1, skipped: 1 });
  list = await (await r.get(base + "/customers?q=&filter=all&sort=recent&limit=50")).json();
  const c2 = list.customers.find((c: { phone: string }) => c.phone === "07700900102");
  expect(c2).toMatchObject({ name: "Babbage, Charles", email: "charles@example.test" }); // name kept, email filled
  const a2 = list.customers.find((c: { phone: string }) => c.phone === "07700900101");
  expect(a2.email).toBe("ada@example.test"); // not overwritten
  const detail = await (await r.get(base + `/customers/${c2.id}`)).json();
  expect(detail.customer.notes).toContain("Prefers Saturdays");

  // Third identical import: nothing to do → 409, honest.
  res = await r.post(base + "/customers/import", { data: { csv: CSV2 } });
  expect(res.status()).toBe(409);

  // Manual mapping override when headers are odd; semicolon delimiter; BOM.
  const ODD = "\uFEFFWho;Number\nZed Zero;07700 900109\n";
  const bad = await r.post(base + "/customers/import/preview", { data: { csv: ODD } });
  expect(bad.status()).toBe(400);
  const ok = await r.post(base + "/customers/import/preview", { data: { csv: ODD, mapping: { name: "Who", phone: "Number" } } });
  expect(ok.status(), await ok.text()).toBe(200);
  expect((await ok.json()).counts.create).toBe(1);

  // Audit trail.
  const w = await (await r.get(base + "/workspace")).json();
  expect(w.audit.some((a: { action: string }) => a.action === "CUSTOMERS_IMPORTED")).toBe(true);
});

test("import: barber cannot import", async () => {
  const b = await request.newContext({ extraHTTPHeaders: { Origin: origin } });
  const res = await b.post(base + "/auth/demo", { data: { fixture: true, as: "barber" } });
  expect([200, 201]).toContain(res.status());
  expect((await b.post(base + "/customers/import/preview", { data: { csv: "name,phone\nX,07700900100" } })).status()).toBe(403);
  expect((await b.post(base + "/customers/import", { data: { csv: "name,phone\nX,07700900100" } })).status()).toBe(403);
});

test("browser: Customers → Import → choose file → preview counts → import → directory refreshes", async ({ page }) => {
  await openFixtureShop(page);
  await section(page, "Customers");
  await page.getByTestId("import-customers").click();
  const modal = page.getByTestId("import-modal");
  await expect(modal).toBeVisible();
  const stamp = Date.now().toString().slice(-6);
  const csv = `Name,Mobile,Email\nImported Ivy ${stamp},07700 9${stamp.slice(0, 5)},ivy${stamp}@example.test\nImported Ian ${stamp},07700 8${stamp.slice(0, 5)},\nNo Number,,x@example.test\n`;
  await modal.getByTestId("import-file").setInputFiles({ name: "clients.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(modal.getByTestId("import-counts")).toContainText("2 new");
  await expect(modal.getByTestId("import-counts")).toContainText("1 can't import");
  await expect(modal.getByTestId("import-commit")).toContainText("Import 2 customers");
  await modal.getByTestId("import-commit").click();
  await expect(modal.getByTestId("import-result")).toContainText("2 added, 0 updated");
  await modal.getByRole("button", { name: "Done" }).click();
  await expect(modal).toBeHidden();
  await page.getByPlaceholder("Search name, mobile, email or tag").fill(`Imported Ivy ${stamp}`);
  await expect(page.getByText(`Imported Ivy ${stamp}`).first()).toBeVisible();
});
