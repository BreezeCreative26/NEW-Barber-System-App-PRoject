import { chromium } from "@playwright/test";
const O = "http://localhost:3000";
const b = await chromium.launch();
const c = await b.newContext({ viewport: { width: 1366, height: 768 } });
const p = await c.newPage();
await p.request.post(O + "/api/app/auth/demo", { headers: { Origin: O }, data: { fixture: true } });
await p.goto(O + "/workspace"); await p.getByRole("button", { name: "New booking", exact: true }).waitFor();
for (const d of ["compact", "standard", "large"]) {
  await p.getByTestId(`density-${d}`).click(); await p.waitForTimeout(400);
  const m = await p.evaluate(() => { const el = document.querySelector(".connected-scroll"); return { sh: el.scrollHeight, ch: el.clientHeight, top: el.getBoundingClientRect().top }; });
  console.log(d, m);
  await p.screenshot({ path: `/tmp/dens-${d}.png` });
}
// persistence
await p.getByTestId("density-compact").click(); await p.waitForTimeout(500);
await p.reload(); await p.getByRole("button", { name: "New booking", exact: true }).waitFor(); await p.waitForTimeout(500);
console.log("after reload", await p.getByTestId("density-compact").getAttribute("aria-checked"));
await c.close();
const c2 = await b.newContext({ viewport: { width: 390, height: 844 } });
const p2 = await c2.newPage();
await p2.request.post(O + "/api/app/auth/demo", { headers: { Origin: O }, data: { fixture: true } });
await p2.goto(O + "/workspace"); await p2.getByRole("button", { name: "New booking", exact: true }).waitFor(); await p2.waitForTimeout(500);
await p2.screenshot({ path: "/tmp/dens-phone.png" });
await b.close();
