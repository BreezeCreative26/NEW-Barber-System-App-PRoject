import { chromium } from "@playwright/test";
const base = "http://localhost:3000";
const b = await chromium.launch(); const ctx = await b.newContext({viewport:{width:1366,height:900}}); const page = await ctx.newPage();
const errors=[]; page.on("pageerror",e=>errors.push("PAGEERROR "+e.message.slice(0,150)));
page.on("response",r=>{ if(r.status()>=400 && !r.url().includes("favicon")) errors.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().replace(base,"")}`); });
const text = async (sel="body") => (await page.locator(sel).innerText()).replace(/\n{2,}/g,"\n");
await page.request.post(base+"/api/sandbox/auth/demo",{headers:{Origin:base},data:{as:"owner"}});
await page.goto(base+"/workspace"); await page.waitForTimeout(2000);
// 1. New booking form
await page.getByRole("button",{name:"New booking",exact:true}).click(); await page.waitForTimeout(800);
console.log("--- New booking form ---\n", (await text("[role=dialog], aside, form").catch(()=>text())).slice(0,1500));
await page.screenshot({path:"/tmp/o-newbooking.png", fullPage:true});
await page.keyboard.press("Escape"); await page.waitForTimeout(400);
// 2. Open tomorrow's Audit Tester appointment
await page.getByLabel("Appointment date",{exact:true}).fill(new Date(Date.now()+86400000).toISOString().slice(0,10));
await page.getByRole("button",{name:"Refresh",exact:true}).click(); await page.waitForTimeout(1200);
await page.getByRole("button",{name:/Audit Tester/}).first().click(); await page.waitForTimeout(800);
const panel = page.getByTestId("appointment-panel");
console.log("--- Appointment panel ---\n", (await panel.innerText()).replace(/\n{2,}/g,"\n").slice(0,2000));
console.log("panel buttons:", (await panel.locator("button:visible").allInnerTexts()).filter(Boolean));
await page.screenshot({path:"/tmp/o-panel.png", fullPage:true});
// 3. Notifications bell
await panel.getByRole("button",{name:/^Close/}).first().click().catch(()=>{});
await page.getByRole("button",{name:/notification|alerts|bell/i}).first().click().catch(e=>console.log("no bell button by name"));
await page.waitForTimeout(600); console.log("--- bell ---\n", (await text()).slice(0,300));
await page.screenshot({path:"/tmp/o-bell.png"});
// 4. Waiting chip
await page.keyboard.press("Escape");
await page.getByRole("button",{name:/waiting/i}).first().click().catch(()=>console.log("no waiting chip")); await page.waitForTimeout(800);
console.log("--- waitlist ---\n", (await text("[role=dialog]").catch(()=>"no dialog")).slice(0,1500));
await page.screenshot({path:"/tmp/o-waitlist.png", fullPage:true});
await page.keyboard.press("Escape");
// 5. Team -> open barber
const nav = page.getByRole("navigation",{name:"Workspace sections"});
await nav.getByRole("button",{name:"Team",exact:true}).click(); await page.waitForTimeout(600);
await page.getByRole("button",{name:/Jay Carter/}).first().click(); await page.waitForTimeout(800);
console.log("--- Barber studio ---\n", (await text("[role=dialog]").catch(()=>text("main"))).slice(0,2500));
await page.screenshot({path:"/tmp/o-barber.png", fullPage:true});
await page.keyboard.press("Escape");
// 6. Services -> open service
await nav.getByRole("button",{name:"Services",exact:true}).click(); await page.waitForTimeout(600);
await page.getByRole("button",{name:/Signature cut/}).first().click(); await page.waitForTimeout(800);
console.log("--- Service studio ---\n", (await text("[role=dialog]").catch(()=>text("main"))).slice(0,2500));
await page.screenshot({path:"/tmp/o-service.png", fullPage:true});
await page.keyboard.press("Escape");
// 7. Customer profile
await nav.getByRole("button",{name:"Customers",exact:true}).click(); await page.waitForTimeout(600);
await page.getByRole("button",{name:/Hugo Reid/}).first().click(); await page.waitForTimeout(800);
console.log("--- Customer profile ---\n", (await text("[role=dialog]").catch(()=>text("main"))).slice(0,2500));
await page.screenshot({path:"/tmp/o-customer.png", fullPage:true});
// 8. Account menu
await page.keyboard.press("Escape");
await page.getByTestId("account-pill").click(); await page.waitForTimeout(500);
console.log("--- account menu ---\n", await page.getByRole("menu").innerText().catch(()=>"no menu"));
console.log("ERRORS", errors);
await b.close();
