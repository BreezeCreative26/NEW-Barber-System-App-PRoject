// Feature permissions. Everyone gets the same calendar and the same screens; what changes is which
// features each account can use. Defaults come from the role, and the owner can switch any of them
// on or off per person in Accounts. The owner always has everything.
export type PermKey =
  | "calendar_all" | "manage_others" | "book" | "payments" | "customers_all" | "customer_contact"
  | "waitlist" | "messages" | "export" | "all_notifications" | "insights" | "pay" | "setup";
type Role = "BARBER" | "RECEPTION" | "MANAGER";
export const PERM_DEFS: { key: PermKey; group: string; label: string; hint: string; defaults: Record<Role, boolean> }[] = [
  { key: "calendar_all", group: "Calendar", label: "See other barbers' appointment details", hint: "Otherwise other barbers' appointments show as Busy.", defaults: { BARBER: false, RECEPTION: true, MANAGER: true } },
  { key: "book", group: "Calendar", label: "Add new appointments", hint: "Includes standing (repeat) bookings.", defaults: { BARBER: true, RECEPTION: true, MANAGER: true } },
  { key: "manage_others", group: "Calendar", label: "Move, cancel and complete other barbers' appointments", hint: "Otherwise only their own.", defaults: { BARBER: false, RECEPTION: true, MANAGER: true } },
  { key: "waitlist", group: "Calendar", label: "Use the waiting list", hint: "Barbers see people waiting for their own chair; with the details switch on, everyone's.", defaults: { BARBER: true, RECEPTION: true, MANAGER: true } },
  { key: "customers_all", group: "Customers", label: "See every customer", hint: "Otherwise only customers they have booked.", defaults: { BARBER: false, RECEPTION: true, MANAGER: true } },
  { key: "customer_contact", group: "Customers", label: "See phone numbers and emails", hint: "Otherwise contact details are hidden.", defaults: { BARBER: true, RECEPTION: true, MANAGER: true } },
  { key: "export", group: "Customers", label: "Import and export customer lists", hint: "CSV files in and out.", defaults: { BARBER: false, RECEPTION: false, MANAGER: true } },
  { key: "payments", group: "Money", label: "Take payments and refunds", hint: "Checkout, pay links, card reader and refunds.", defaults: { BARBER: true, RECEPTION: true, MANAGER: true } },
  { key: "insights", group: "Money", label: "See whole-shop insights", hint: "Otherwise only their own numbers.", defaults: { BARBER: false, RECEPTION: false, MANAGER: true } },
  { key: "pay", group: "Money", label: "See pay runs and wallets", hint: "Otherwise only their own pay.", defaults: { BARBER: false, RECEPTION: false, MANAGER: true } },
  { key: "messages", group: "Shop", label: "See sent messages and reviews", hint: "The message log and customer reviews.", defaults: { BARBER: false, RECEPTION: true, MANAGER: true } },
  { key: "all_notifications", group: "Shop", label: "See all notifications", hint: "Bell and push for every barber's bookings. Otherwise only their own.", defaults: { BARBER: false, RECEPTION: true, MANAGER: true } },
  { key: "setup", group: "Shop", label: "Change services, hours and shop settings", hint: "Never billing or who can sign in.", defaults: { BARBER: false, RECEPTION: false, MANAGER: true } },
];
export const PERM_KEYS = PERM_DEFS.map((d) => d.key);
export type Perms = Partial<Record<PermKey, boolean>>;
// Older rows stored one "calendar" switch for "see everyone's calendar and customers".
export function effectivePerms(role: string, storedJson: string | null | undefined): Record<PermKey, boolean> {
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(storedJson || "{}"); } catch { raw = {}; }
  const out = {} as Record<PermKey, boolean>;
  for (const d of PERM_DEFS) {
    if (role === "OWNER") { out[d.key] = true; continue; }
    const legacy = typeof raw.calendar === "boolean" && (d.key === "calendar_all" || d.key === "customers_all") ? (raw.calendar as boolean) : undefined;
    const v = typeof raw[d.key] === "boolean" ? (raw[d.key] as boolean) : legacy;
    out[d.key] = v ?? d.defaults[(role === "BARBER" || role === "RECEPTION" ? role : "MANAGER") as Role];
  }
  return out;
}
