import { chromium } from "@playwright/test";
const base = "http://localhost:3000";
const b = await chromium.launch(); const ctx = await b.newContext({ viewport:{width:1366,height:900} });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", e => errors.push("PAGEERROR " + e.message));
page.on("console", m => { if (m.type()==="error") errors.push("CONSOLE " + m.text().slice(0,200)); });
page.on("response", r => { if (r.status()>=400 && !r.url().includes("favicon")) errors.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().replace(base,"")}`); });
// demo login (standard demo shop)
const r = await page.request.post(base+"/api/sandbox/auth/demo",{headers:{Origin:base},data:{as:"owner"}});
console.log("demo login", r.status(), (await r.text()).slice(0,200));
await page.goto(base+"/workspace"); await page.waitForTimeout(2500);
console.log("title:", await page.title());
const nav = page.getByRole("navigation",{name:"Workspace sections"});
const buttons = await nav.getByRole("button").allInnerTexts();
console.log("nav:", buttons);
for (const name of buttons) {
  if (!name.trim()) continue;
  await nav.getByRole("button",{name, exact:true}).click().catch(e=>errors.push("navclick "+name+" "+e.message.slice(0,80)));
  await page.waitForTimeout(1200);
  const h = await page.locator("main h1, main h2").allInnerTexts();
  const btns = (await page.locator("main button:visible").allInnerTexts()).filter(Boolean).slice(0,40);
  const emptyish = await page.locator("main").innerText();
  console.log(`\n=== ${name} === headings: ${JSON.stringify(h.slice(0,8))}`);
  console.log("buttons:", JSON.stringify(btns));
  console.log("text len:", emptyish.length, "| coming soon / not yet / placeholder mentions:", (emptyish.match(/coming soon|not yet|placeholder|soon|later|todo/gi)||[]).slice(0,6));
  await page.screenshot({path:`/tmp/audit-${name.replace(/\W+/g,"_")}.png`, fullPage:true});
}
console.log("\nERRORS:", errors);
await b.close();
