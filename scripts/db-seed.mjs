// Build (or rebuild) the Demo Barbershop through the app's own seed route so it goes through the
// same code path as the UI. Usage: node scripts/db-seed.mjs [http://localhost:3000]
const origin = process.argv[2] || process.env.APP_ORIGIN || "http://localhost:3000";
const r = await fetch(`${origin}/api/sandbox/auth/demo`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ rebuild: true }) });
console.log(r.status, await r.text());
