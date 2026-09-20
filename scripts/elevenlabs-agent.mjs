// Configure an ElevenLabs Conversational AI agent as one shop's OLLO receptionist.
//
//   ELEVENLABS_API_KEY=sk_… node scripts/elevenlabs-agent.mjs <slug> <ollo_vk_secret> [--agent agent_id] [--origin https://…]
//
// One agent per shop. Creates (or, with --agent, updates) the agent with: system prompt, first
// message, dynamic-variable defaults, six webhook tools on /api/voice/<slug>/*, the conversation-
// initiation webhook (/personalise, bearer) and a workspace post-call webhook (/post-call, HMAC).
// Idempotent: tools/webhooks with the same name+URL are reused. Prints the agent id and the
// post-call webhook secret (paste that into the shop's AI receptionist panel, or pass --owner-login
// email:password to store it automatically).
const key = process.env.ELEVENLABS_API_KEY;
const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1].startsWith("--")));
const [slug, secret] = positional;
const flag = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const origin = (flag("--origin") || process.env.APP_ORIGIN || "https://new-barber-system-app-p-roject.vercel.app").replace(/\/$/, "");
if (!key || !slug || !secret) { console.error("usage: ELEVENLABS_API_KEY=sk_… node scripts/elevenlabs-agent.mjs <slug> <ollo_vk_secret> [--agent agent_id] [--owner-login email:password]"); process.exit(1); }

const el = async (path, method = "GET", body) => {
  const res = await fetch("https://api.elevenlabs.io" + path, { method, headers: { "xi-api-key": key, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${typeof json === "string" ? json : JSON.stringify(json).slice(0, 600)}`);
  return json;
};

// Shop facts from OLLO — also proves the secret before touching ElevenLabs.
const base = `${origin}/api/voice/${slug}`;
const infoRes = await fetch(`${base}/info`, { headers: { Authorization: `Bearer ${secret}` } });
const info = await infoRes.json();
if (!infoRes.ok || !info.shop) throw new Error(`OLLO ${base}/info → ${infoRes.status} ${JSON.stringify(info).slice(0, 200)}`);
const shopName = info.shop.name;

const prompt = `You are the friendly receptionist for ${shopName}, a barbershop. Speak naturally and briefly, like a real front-desk person. Never invent availability, prices or policies — always use the tools.

Context for this call: today is {{today}}; we are open {{today_hours}}. Services: {{services}}. Barbers: {{barbers}}. Cancellation policy: {{cancel_hours}} hours' notice. Caller's number: {{caller_phone}}. Known customer: {{caller_name}}. Their next booking: {{caller_upcoming}}. Shop notes: {{shop_notes}}.

Every tool returns a field called "say". Speak that sentence to the caller (you may soften or shorten it) rather than reading raw data. If a tool returns ok: false, the "say" field explains the problem and usually offers alternatives — use it and keep the conversation moving. Only ever quote times, prices and reference numbers that appeared in a tool result in this call. If a tool result is missing, empty or says nothing useful, say "let me just check that" and call it again; if it still fails, apologise and offer request_callback. Never make up a time, a price or a reference.

To book: find out the service, the day, roughly what time, and whether they want a particular barber. Call check_availability, offer two or three times, then collect their name and confirm the mobile number (use {{caller_phone}} if they say "this number"; read it back once). Ask whether they'd like the confirmation by text or WhatsApp. Read the full details back once, wait for a yes, then call book_appointment and tell them the reference.

To cancel or check a booking: ask for the mobile number, call find_bookings, confirm which one, then cancel_booking. Mention the cancellation policy if the "say" field says it applies.

For questions about hours, prices, services, the team or the shop, call get_business_information.

If you cannot help — walk-in questions you can't answer, complaints, payments or refunds, group bookings over four, hair advice, anything unusual — call request_callback with a short note and reassure them the team will ring back.

Style: one or two sentences per turn. Say dates as day and date ("Wednesday the 23rd"). Use 12-hour times ("half past two", "10 am"). Don't list more than three times at once. Never say you are an AI unless asked directly; if asked, say you're the shop's automated receptionist and the team can call back if they'd prefer a person. End calls warmly, confirm the next step, then end the call.`;

const str = (description) => ({ type: "string", description });
const TOOLS = [
  { name: "get_business_information", method: "GET", path: "/info", description: `Returns ${shopName}'s address, opening hours per day, services with price and duration, barbers, and policies (cancellation notice, deposits, booking window). Call when the caller asks about hours, prices, services, who works there, or anything about the shop.` },
  { name: "check_availability", method: "GET", path: "/availability", description: "Returns open appointment times for a service on a given day, optionally with a particular barber and near a requested time. Always call this before offering times. Read the `say` field to the caller.",
    query: { service: str("The service as the caller said it, e.g. 'skin fade', 'cut and beard'"), date: str("The day as said: 'tomorrow', 'Friday', 'next Tuesday', 'the 23rd', or YYYY-MM-DD"), barber: str("Barber's name if they asked for one, otherwise 'any'"), time: str("Rough time wanted, e.g. '10am', 'half two', '14:00'. Optional.") }, required: ["service", "date"] },
  { name: "book_appointment", method: "POST", path: "/book", description: "Saves the appointment and sends the customer their confirmation. Only call after reading the details back and getting a clear yes. If the response has ok: false, read `say` — it offers alternative times.",
    body: { name: str("Caller's full name"), phone: str("UK mobile number starting 07. If the caller says 'this number', use the caller ID."), service: str("Service name as said"), date: str("Day as said or YYYY-MM-DD"), time: str("Time as said, e.g. '2pm', '10:30'"), barber: str("Barber's name, or 'any'. Optional."), email: str("Email address if they want an email confirmation. Optional."), notes: str("Anything the shop should know. Optional."), contact_pref: str("How they want the confirmation: 'SMS' for text, 'WA' for WhatsApp, 'EMAIL'. Optional.") }, required: ["name", "phone", "service", "date", "time"] },
  { name: "find_bookings", method: "GET", path: "/bookings", description: "Lists the caller's upcoming appointments by mobile number. Call before cancelling or when they ask when they are booked in.", query: { phone: str("UK mobile number the booking was made with") }, required: ["phone"] },
  { name: "cancel_booking", method: "POST", path: "/cancel", description: "Cancels one upcoming appointment. Call find_bookings first if there could be more than one; pass the reference or booking_id to pick one.", body: { phone: str("UK mobile number the booking was made with"), reference: str("Booking reference like 'OLL-0412' if known. Optional."), booking_id: str("booking_id from find_bookings if known. Optional.") }, required: ["phone"] },
  { name: "request_callback", method: "POST", path: "/callback", description: "Leaves a message for the shop team when you cannot help: complaints, payments or refunds, group bookings over four, hair advice, anything unusual. The team rings the caller back.", body: { name: str("Caller's name"), phone: str("Number to call back on"), note: str("What the caller wants, in one or two sentences") }, required: ["note"] },
];
const toolConfig = (t) => ({
  type: "webhook", name: t.name, description: t.description, response_timeout_secs: 20,
  api_schema: {
    url: base + t.path, method: t.method, request_headers: { Authorization: `Bearer ${secret}` },
    ...(t.query ? { query_params_schema: { properties: t.query, required: t.required } } : {}),
    ...(t.body ? { request_body_schema: { type: "object", properties: t.body, required: t.required, description: `${t.name} payload` } } : {}),
  },
});

// Tools — reuse by name + URL so re-running never duplicates.
const existing = (await el("/v1/convai/tools")).tools || [];
const toolIds = [];
for (const t of TOOLS) {
  const cfg = toolConfig(t);
  const prev = existing.find((x) => x.tool_config?.name === t.name && x.tool_config?.api_schema?.url === cfg.api_schema.url);
  const saved = prev ? await el(`/v1/convai/tools/${prev.id}`, "PATCH", { tool_config: cfg }) : await el("/v1/convai/tools", "POST", { tool_config: cfg });
  toolIds.push(saved.id);
  console.log(`${prev ? "updated" : "created"} tool  ${t.name.padEnd(26)} ${saved.id}`);
}

// Post-call webhook (workspace-level, HMAC-signed). ElevenLabs shows the secret only on creation.
let postCallId = null, webhookSecret = null;
const hookUrl = `${base}/post-call`;
const hooks = (await el("/v1/workspace/webhooks?include_usages=true")).webhooks || [];
const mine = hooks.find((h) => h.webhook_url === hookUrl && !h.is_disabled);
if (mine) { postCallId = mine.webhook_id; console.log(`reusing post-call webhook ${postCallId} (secret already issued)`); }
else {
  const created = await el("/v1/workspace/webhooks", "POST", { settings: { name: `OLLO post-call - ${shopName}`, webhook_url: hookUrl, auth_type: "hmac" } });
  postCallId = created.webhook_id; webhookSecret = created.webhook_secret;
  console.log(`created post-call webhook ${postCallId}`);
}

const dyn = { shop_name: shopName, today: "today", today_hours: "our usual hours", services: info.services.map((s) => `${s.name} (${s.duration}, ${s.price})`).join("; "), barbers: info.barbers.map((b) => b.name).join(", "), cancel_hours: (String(info.policies?.cancellation || "").match(/\d+/) || ["24"])[0], caller_phone: "", caller_name: "", caller_upcoming: "", shop_notes: info.notes || "" };
const agentBody = {
  name: `${shopName} — OLLO receptionist`,
  conversation_config: {
    agent: {
      first_message: `Hello, you're through to ${shopName}. How can I help today?`,
      language: "en",
      dynamic_variables: { dynamic_variable_placeholders: dyn },
      prompt: { prompt, tool_ids: toolIds, built_in_tools: { end_call: { name: "end_call", description: "End the call once the caller is done and you have said goodbye.", type: "system", params: { system_tool_type: "end_call" } } } },
    },
    tts: { model_id: "eleven_flash_v2" },
    conversation: { max_duration_seconds: 900 },
  },
  platform_settings: {
    overrides: { enable_conversation_initiation_client_data_from_webhook: true, conversation_config_override: { agent: { first_message: true } } },
    workspace_overrides: {
      conversation_initiation_client_data_webhook: { url: `${base}/personalise`, request_headers: { Authorization: `Bearer ${secret}` } },
      webhooks: { post_call_webhook_id: postCallId, events: ["transcript"], transcript_format: "json", send_audio: false },
    },
  },
};
const agentId = flag("--agent");
const agent = agentId ? await el(`/v1/convai/agents/${agentId}`, "PATCH", agentBody) : await el("/v1/convai/agents/create", "POST", agentBody);
const id = agent.agent_id || agentId;
console.log(`${agentId ? "updated" : "created"} agent ${id}`);

// Store agent id (+ webhook secret) on the shop so the panel and /post-call know about them.
const login = flag("--owner-login");
if (login) {
  const [email, ...pw] = login.split(":");
  const appBase = `${origin}/api/app`;
  let cookie = "";
  const api = async (path, method, data) => {
    const res = await fetch(appBase + path, { method, headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie }, body: data ? JSON.stringify(data) : undefined, redirect: "manual" });
    const sc = res.headers.getSetCookie?.() || []; if (sc.length) cookie = sc.map((s) => s.split(";")[0]).join("; ");
    const t = await res.text(); if (!res.ok) throw new Error(`${method} ${path} ${res.status} ${t.slice(0, 200)}`); return JSON.parse(t);
  };
  await api("/auth/login", "POST", { email, password: pw.join(":") });
  const cur = (await api("/shop/voice", "GET")).settings;
  await api("/shop/voice", "PUT", { enabled: true, agent_id: id, greeting: cur.greeting, notes: cur.notes, ...(webhookSecret ? { webhook_secret: webhookSecret } : {}) });
  console.log(`stored agent id${webhookSecret ? " + webhook secret" : ""} on the shop`);
} else if (webhookSecret) {
  console.log(`\nPOST-CALL WEBHOOK SECRET (shown once): ${webhookSecret}\nPaste it into Workspace → Settings → AI receptionist → "ElevenLabs webhook secret".`);
}

const final = await el(`/v1/convai/agents/${id}`);
console.log(`\nagent: ${final.name}  ${id}`);
console.log(`tools: ${final.conversation_config.agent.prompt.tool_ids.length}`);
console.log(`initiation webhook: ${final.platform_settings.workspace_overrides?.conversation_initiation_client_data_webhook?.url || "(not set)"}`);
console.log(`post-call webhook: ${final.platform_settings.workspace_overrides?.webhooks?.post_call_webhook_id || "(not set)"}`);
console.log(`\nTest: https://elevenlabs.io/app/agents/${id}\nPhone: Agents → Phone numbers → buy or import → assign this agent.`);
