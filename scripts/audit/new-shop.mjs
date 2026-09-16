import { chromium } from "@playwright/test";
const base = "http://localhost:3000";
const b = await chromium.launch(); const ctx = await b.newContext({viewport:{width:1366,height:900}}); const page = await ctx.newPage();
const errors=[]; page.on("pageerror",e=>errors.push("PAGEERROR "+e.message.slice(0,150)));
page.on("response",r=>{ if(r.status()>=400 && !r.url().includes("favicon")) errors.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().replace(base,"")}`); });
const text = async (sel="body") => (await page.locator(sel).innerText()).replace(/\n{2,}/g,"\n");
await page.goto(base+"/workspace"); await page.waitForTimeout(1500);
await page.locator("summary").filter({hasText:"blank test shop"}).click(); await page.waitForTimeout(600);
console.log("--- blank shop form ---\n", (await text("main")).slice(-900));
await page.getByLabel("Test shop name").fill("Audit Cuts");
await page.getByRole("button",{name:"Create test workspace"}).click(); await page.waitForTimeout(2500);
console.log("--- new shop workspace ---\n", (await text("main")).slice(0,1500));
await page.screenshot({path:"/tmp/new-shop.png", fullPage:true});
const nav = page.getByRole("navigation",{name:"Workspace sections"});
for (const s of ["Team","Services","Settings","Accounts"]) { await nav.getByRole("button",{name:s,exact:true}).click(); await page.waitForTimeout(700); console.log(`\n[${s}]\n`, (await text("main")).slice(0,900)); await page.screenshot({path:`/tmp/new-${s}.png`, fullPage:true}); }
console.log("ERRORS", errors);
await b.close();
