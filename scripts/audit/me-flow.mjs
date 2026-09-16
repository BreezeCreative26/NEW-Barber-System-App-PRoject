import { chromium } from "@playwright/test";
const base = "http://localhost:3000";
const b = await chromium.launch(); const ctx = await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}); const page = await ctx.newPage();
const errors=[]; page.on("pageerror",e=>errors.push("PAGEERROR "+e.message.slice(0,150)));
page.on("response",r=>{ if(r.status()>=400) errors.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().replace(base,"")}`); });
const text = async () => (await page.locator("body").innerText()).replace(/\n{2,}/g,"\n");
await page.goto(base+"/demo/me"); await page.waitForTimeout(1000);
await page.getByLabel("Mobile number").fill("07700 900999"); await page.getByRole("button",{name:"Send code"}).click(); await page.waitForTimeout(1200);
console.log("--- after send code ---\n", (await text()).slice(0,1200));
await page.screenshot({path:"/tmp/me-code.png", fullPage:true});
const code = (await text()).match(/code is (\d{6})/)?.[1]; console.log("code found:", code);
if (code) { await page.getByLabel(/code/i).first().fill(code); await page.getByRole("button",{name:/verify|sign in|continue/i}).first().click(); await page.waitForTimeout(1500);
 console.log("--- signed in ---\n", (await text()).slice(0,2500)); await page.screenshot({path:"/tmp/me-in.png", fullPage:true});
 const tabs = await page.getByRole("tab").allInnerTexts().catch(()=>[]); console.log("tabs", tabs);
 for (const t of tabs){ await page.getByRole("tab",{name:t}).click(); await page.waitForTimeout(600); console.log(`\n[${t}]\n`, (await text()).slice(0,1200)); await page.screenshot({path:`/tmp/me-${t.replace(/\W+/g,'_')}.png`, fullPage:true}); }
}
console.log("ERRORS", errors);
await b.close();
