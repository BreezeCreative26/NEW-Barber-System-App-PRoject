// Fictional design fixtures only. These are not customer records or live availability.
export const SAMPLE_DAY = "2026-09-14";
export const SAMPLE_NOW = 10 * 60 + 30;
export const BUFFER = 10;
export const money = (pence: number) =>
  new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: pence % 100 ? 2 : 0,
  }).format(pence / 100);
export const time = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
export const datePlus = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
export const dateLabel = (
  date: string,
  options: Intl.DateTimeFormatOptions = {
    weekday: "long",
    day: "numeric",
    month: "long",
  },
) =>
  new Intl.DateTimeFormat("en-GB", {
    ...options,
    timeZone: "Europe/London",
  }).format(new Date(`${date}T12:00:00Z`));
export const isClosed = (date: string) =>
  new Date(`${date}T12:00:00Z`).getUTCDay() === 0;
export const staff = [
  {
    id: "jay",
    name: "Jay Carter",
    initials: "JC",
    role: "Senior barber",
    colour: "sage",
    description: "Precision fades. Effortless finishes.",
    rating: "4.9",
  },
  {
    id: "marcus",
    name: "Marcus Reed",
    initials: "MR",
    role: "Barber",
    colour: "sand",
    description: "Classic cuts with a modern edge.",
    rating: "4.9",
  },
  {
    id: "luca",
    name: "Luca Hayes",
    initials: "LH",
    role: "Barber",
    colour: "blue",
    description: "Texture, movement and good conversation.",
    rating: "4.8",
  },
  {
    id: "theo",
    name: "Theo Brooks",
    initials: "TB",
    role: "Barber",
    colour: "clay",
    description: "Sharp lines. A little extra attention.",
    rating: "4.9",
  },
];
export const services = [
  {
    id: "cut",
    name: "Signature cut",
    category: "Hair",
    description: "A considered cut, styled your way.",
    duration: 30,
    price: 2800,
    popular: true,
    icon: "scissors",
  },
  {
    id: "fade",
    name: "Skin fade",
    category: "Hair",
    description: "Seamless detail. A seriously fresh finish.",
    duration: 45,
    price: 3200,
    popular: true,
    icon: "sparkles",
  },
  {
    id: "beard",
    name: "Beard sculpt",
    category: "Beard",
    description: "Shape, define and finish with care.",
    duration: 25,
    price: 1800,
    popular: false,
    icon: "razor",
  },
  {
    id: "combo",
    name: "Cut & beard",
    category: "Packages",
    description: "The complete refresh, from top to bottom.",
    duration: 60,
    price: 4200,
    popular: true,
    icon: "package",
  },
  {
    id: "junior",
    name: "Junior cut",
    category: "Hair",
    description: "A little style for the next generation.",
    duration: 30,
    price: 2000,
    popular: false,
    icon: "scissors",
  },
];
export const addons = [
  { id: "towel", name: "Hot towel finish", price: 400, duration: 10 },
  { id: "scalp", name: "Scalp massage", price: 600, duration: 10 },
];
export type Booking = {
  id: string;
  barber: string;
  customer: string;
  service: string;
  start: number;
  duration: number;
  price: number;
  deposit: number;
  status: "Completed" | "In chair" | "Checked in" | "Confirmed";
  source?: "Walk-in";
  note?: string;
};
export const bookings: Booking[] = [
  {
    id: "demo-101",
    barber: "jay",
    customer: "Oliver Wilson",
    service: "Skin fade",
    start: 540,
    duration: 45,
    price: 3500,
    deposit: 500,
    status: "Completed",
  },
  {
    id: "demo-102",
    barber: "jay",
    customer: "Daniel Thompson",
    service: "Cut & beard",
    start: 610,
    duration: 60,
    price: 4200,
    deposit: 500,
    status: "In chair",
    note: "Prefers a natural finish. Sample note only.",
  },
  {
    id: "demo-103",
    barber: "jay",
    customer: "James Anderson",
    service: "Signature cut",
    start: 690,
    duration: 30,
    price: 2800,
    deposit: 500,
    status: "Confirmed",
  },
  {
    id: "demo-104",
    barber: "jay",
    customer: "Ethan Parker",
    service: "Skin fade",
    start: 840,
    duration: 45,
    price: 3500,
    deposit: 500,
    status: "Confirmed",
  },
  {
    id: "demo-105",
    barber: "jay",
    customer: "Harry Collins",
    service: "Signature cut",
    start: 930,
    duration: 30,
    price: 2800,
    deposit: 0,
    status: "Confirmed",
    source: "Walk-in",
  },
  {
    id: "demo-201",
    barber: "marcus",
    customer: "Noah Davies",
    service: "Signature cut",
    start: 555,
    duration: 30,
    price: 2800,
    deposit: 500,
    status: "Completed",
  },
  {
    id: "demo-202",
    barber: "marcus",
    customer: "Alex Morgan",
    service: "Skin fade",
    start: 645,
    duration: 45,
    price: 3200,
    deposit: 500,
    status: "Checked in",
  },
  {
    id: "demo-203",
    barber: "marcus",
    customer: "Leo Mitchell",
    service: "Beard sculpt",
    start: 720,
    duration: 25,
    price: 1800,
    deposit: 500,
    status: "Confirmed",
  },
  {
    id: "demo-204",
    barber: "marcus",
    customer: "Finn Roberts",
    service: "Cut & beard",
    start: 825,
    duration: 60,
    price: 4200,
    deposit: 500,
    status: "Confirmed",
  },
  {
    id: "demo-205",
    barber: "marcus",
    customer: "Archie Brown",
    service: "Signature cut",
    start: 945,
    duration: 30,
    price: 2800,
    deposit: 500,
    status: "Confirmed",
  },
  {
    id: "demo-301",
    barber: "luca",
    customer: "Charlie Edwards",
    service: "Cut & beard",
    start: 540,
    duration: 60,
    price: 4200,
    deposit: 500,
    status: "Completed",
  },
  {
    id: "demo-302",
    barber: "luca",
    customer: "Oscar Bennett",
    service: "Signature cut",
    start: 630,
    duration: 30,
    price: 2800,
    deposit: 500,
    status: "In chair",
  },
  {
    id: "demo-303",
    barber: "luca",
    customer: "George Turner",
    service: "Skin fade",
    start: 705,
    duration: 45,
    price: 3200,
    deposit: 0,
    status: "Confirmed",
    source: "Walk-in",
  },
  {
    id: "demo-304",
    barber: "luca",
    customer: "Henry Phillips",
    service: "Signature cut",
    start: 870,
    duration: 30,
    price: 2800,
    deposit: 500,
    status: "Confirmed",
  },
  {
    id: "demo-401",
    barber: "theo",
    customer: "Freddie Clarke",
    service: "Skin fade",
    start: 570,
    duration: 45,
    price: 3200,
    deposit: 500,
    status: "Completed",
  },
  {
    id: "demo-402",
    barber: "theo",
    customer: "Arthur Lewis",
    service: "Beard sculpt",
    start: 660,
    duration: 25,
    price: 1800,
    deposit: 500,
    status: "Confirmed",
  },
  {
    id: "demo-403",
    barber: "theo",
    customer: "Jack Walker",
    service: "Signature cut",
    start: 720,
    duration: 30,
    price: 2800,
    deposit: 500,
    status: "Confirmed",
  },
  {
    id: "demo-404",
    barber: "theo",
    customer: "Alfie Scott",
    service: "Cut & beard",
    start: 900,
    duration: 60,
    price: 4200,
    deposit: 500,
    status: "Confirmed",
  },
];
export function appointmentsFor(date: string) {
  if (isClosed(date)) return [];
  return bookings.map((b) => ({
    ...b,
    status:
      date === SAMPLE_DAY
        ? b.status
        : date < SAMPLE_DAY
          ? ("Completed" as const)
          : ("Confirmed" as const),
  }));
}
export function quote(serviceId: string, barberId: string, extraIds: string[]) {
  const service = services.find((s) => s.id === serviceId) ?? services[0];
  const extras = addons.filter((a) => extraIds.includes(a.id));
  const override = barberId === "jay" && serviceId === "fade" ? 300 : 0;
  return {
    service,
    extras,
    override,
    price:
      service.price + override + extras.reduce((sum, a) => sum + a.price, 0),
    duration: service.duration + extras.reduce((sum, a) => sum + a.duration, 0),
    deposit: 500,
  };
}
// Pure fixture evaluator, not the future server-authoritative reservation engine.
export function previewSlotReason(
  date: string,
  barberId: string,
  start: number,
  duration: number,
) {
  if (isClosed(date)) return "Shop closed";
  if (date < SAMPLE_DAY || (date === SAMPLE_DAY && start < SAMPLE_NOW))
    return "Past sample time";
  if (start < 540 || start + duration + BUFFER > 1080)
    return "Outside opening hours";
  if (start < 810 && start + duration + BUFFER > 765) return "Lunch break";
  if (
    appointmentsFor(date).some(
      (b) =>
        b.barber === barberId &&
        start < b.start + b.duration + BUFFER &&
        start + duration + BUFFER > b.start,
    )
  )
    return "Already booked";
  return "";
}
export function validateDetails(values: {
  name: string;
  phone: string;
  email: string;
  notes: string;
}) {
  const errors: Record<string, string> = {};
  if (values.name.trim().length < 2)
    errors.name = "Enter a name with at least 2 characters.";
  const phone = values.phone.replace(/[\s()-]/g, "");
  if (!/^(?:\+44|0)7\d{9}$/.test(phone))
    errors.phone = "Enter a UK mobile number, for example 07700 900123.";
  if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email))
    errors.email = "Enter a valid email address, or leave this blank.";
  if (values.notes.length > 500)
    errors.notes = "Keep notes to 500 characters or fewer.";
  return errors;
}
