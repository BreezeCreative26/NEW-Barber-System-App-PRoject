// A tiny stand-in for api.stripe.com, enough for refunds, transfers, reversals and balance. The app only
// talks to it when STRIPE_API_BASE is set AND the key starts sk_test_ (see stripeApi()).
import http from "node:http";
import type { AddressInfo } from "node:net";

export type FakeCall = { method: string; path: string; body: Record<string, string>; key: string };
export type FakeStripe = {
  url: string; calls: FakeCall[]; close: () => Promise<void>;
  /** Make the next refunds fail with this Stripe error code (null = succeed). */
  failRefunds: (code: string | null) => void;
  balance: { available: number; pending: number };
};

export async function startFakeStripe(port = 0): Promise<FakeStripe> {
  const calls: FakeCall[] = [];
  const seen = new Map<string, unknown>(); // idempotency key -> response
  let refundFail: string | null = null;
  let n = 0;
  const run = Math.random().toString(36).slice(2, 8); // ids must not collide with rows left in a persistent test DB
  const fake = { balance: { available: 1000000, pending: 0 } };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const path = (req.url || "").split("?")[0];
      // Control surface for tests that run the app in another process.
      if (path === "/__fail") { refundFail = new URLSearchParams((req.url || "").split("?")[1] || "").get("code") || null; res.writeHead(200); return res.end("ok"); }
      if (path === "/__calls") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(calls)); }
      const body = Object.fromEntries(new URLSearchParams(raw));
      const key = String(req.headers["idempotency-key"] || "");
      calls.push({ method: req.method || "", path, body, key });
      const send = (status: number, json: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(json)); };
      if (key && seen.has(key)) return send(200, seen.get(key));
      let out: unknown;
      if (path === "/v1/refunds") {
        if (refundFail) return send(400, { error: { message: `fake refund error: ${refundFail}`, code: refundFail } });
        out = { id: `re_${run}${++n}`, status: "succeeded", amount: Number(body.amount || 0) };
      } else if (path === "/v1/transfers") {
        out = { id: `tr_${run}${++n}`, amount: Number(body.amount), destination: body.destination, transfer_group: body.transfer_group };
      } else if (/^\/v1\/transfers\/[^/]+\/reversals$/.test(path)) {
        out = { id: `trr_${run}${++n}`, amount: Number(body.amount || 0) };
      } else if (path === "/v1/balance") {
        out = { available: [{ amount: fake.balance.available, currency: "gbp" }], pending: [{ amount: fake.balance.pending, currency: "gbp" }] };
      } else return send(404, { error: { message: `fake stripe: no route ${path}`, code: "resource_missing" } });
      if (key) seen.set(key, out);
      send(200, out);
    });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url, calls, balance: fake.balance,
    failRefunds: (code) => { refundFail = code; },
    close: () => new Promise((r) => { server.close(() => r()); }),
  } as FakeStripe;
}

// Standalone: `npx tsx tests/support/fake-stripe.ts 4010` (the app is started with STRIPE_API_BASE pointing here).
if (process.argv[1]?.endsWith("fake-stripe.ts") && process.argv[2]) {
  startFakeStripe(Number(process.argv[2])).then((f) => console.log("fake stripe on", f.url));
}
