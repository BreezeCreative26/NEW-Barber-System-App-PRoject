import { chromium } from "@playwright/test";
const base = "http://localhost:3000";
const b = await chromium.launch();
const errors = [];
async function shot(page, name){ await page.screenshot({path:`/tmp/c-${name}.png`, fullPage:true}); }
function wire(page){ page.on("pageerror", e => errors.push("PAGEERROR " + e.message.slice(0,150)));
 page.on("response", r => { if (r.status()>=400 && !r.url().includes("favicon")) errors.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().replace(base,"")}`); }); }
// 1. Fresh visitor, no session
let ctx = await b.newContext({viewport:{width:1366,height:900}}); let page = await ctx.newPage(); wire(page);
await page.goto(base+"/workspace"); await page.waitForTimeout(1500);
console.log("== /workspace no session ==\n", (await page.locator("main, body").first().innerText()).slice(0,1500));
await shot(page,"signin");
// 2. Shop page
await page.goto(base+"/demo"); await page.waitForTimeout(1500);
console.log("\n== /demo ==\n", (await page.locator("body").innerText()).replace(/\n{2,}/g,"\n").slice(0,2500));
await shot(page,"shop");
// 3. Booking page
await page.goto(base+"/book/demo"); await page.waitForTimeout(1500);
console.log("\n== /book/demo ==\n", (await page.locator("body").innerText()).replace(/\n{2,}/g,"\n").slice(0,1800));
await shot(page,"book");
// 4. Customer area
await page.goto(base+"/demo/me"); await page.waitForTimeout(1500);
console.log("\n== /demo/me ==\n", (await page.locator("body").innerText()).replace(/\n{2,}/g,"\n").slice(0,1500));
await shot(page,"me");
// 5. Phone viewport workspace as owner
ctx = await b.newContext({viewport:{width:390,height:844}, isMobile:true, hasTouch:true}); page = await ctx.newPage(); wire(page);
await page.request.post(base+"/api/sandbox/auth/demo",{headers:{Origin:base},data:{as:"barber"}});
await page.goto(base+"/workspace"); await page.waitForTimeout(2000);
console.log("\n== phone barber workspace ==\n", (await page.locator("body").innerText()).replace(/\n{2,}/g,"\n").slice(0,1200));
await shot(page,"phone-barber");
await page.goto(base+"/book/demo"); await page.waitForTimeout(1500); await shot(page,"phone-book");
await page.goto(base+"/demo"); await page.waitForTimeout(1500); await shot(page,"phone-shop");
console.log("\nERRORS:", errors);
await b.close();
