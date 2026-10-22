import { test, expect } from "@playwright/test";
import { newShop } from "./shop";

const base = "http://localhost:3000/api/app";
test("customer messages endpoint answers for a shop customer", async () => {
  const { r } = await newShop("Msgs shop");
  const made = await r.post(base + "/customers", { data: { name: "Msg Person", phone: "07700900777", email: "msg@example.com" } });
  expect(made.status(), await made.text()).toBeLessThan(300);
  const id = (await made.json()).id ?? (await made.json()).customer?.id;
  const res = await r.get(base + `/customers/${id}/messages`);
  expect(res.status(), await res.text()).toBe(200);
  expect(Array.isArray((await res.json()).messages)).toBe(true);
});
