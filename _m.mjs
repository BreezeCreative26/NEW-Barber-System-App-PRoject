import { chromium } from "@playwright/test";
const O = "http://localhost:3000";
const b = await chromium.launch(); const c = await b.newContext({ viewport: { width: 1366, height: 768 } }); const p = await c.newPage();
await p.request.post(O + "/api/app/auth/demo", { headers: { Origin: O }, data: { fixture: true } });
await p.goto(O + "/workspace"); await p.getByRole("button", { name: "New booking", exact: true }).waitFor();
await p.getByTestId("density-compact").click(); await p.waitForTimeout(400);
console.log(await p.evaluate(() => {
  const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return `${sel}: top ${Math.round(b.top)} h ${Math.round(b.height)}`; };
  return [".topbar", ".workspace-main", ".connected-calendar", ".calendar-toolbar-row", ".week-strip", ".connected-scroll", ".calendar-staff-header", ".calendar-timeline", ".calendar-foot"].map(r).join("\n") + "\nfirst label " + document.querySelector(".time-gutter span").textContent + " last " + [...document.querySelectorAll(".time-gutter > span:not(.half)")].pop().textContent;
}));
await b.close();
