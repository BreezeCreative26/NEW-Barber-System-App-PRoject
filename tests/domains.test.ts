// A shop's own domain: validation, link rewriting and request routing, without any network or database.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normaliseDomain, toCustomerDomain } from "../src/server/domains";
import { routeByHost } from "../src/server/hosts";

const saved = { o: process.env.APP_ORIGIN, r: process.env.APP_ROOT_HOST };
beforeEach(() => { process.env.APP_ORIGIN = "https://foliyo.co.uk"; delete process.env.APP_ROOT_HOST; });
afterEach(() => { if (saved.o === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = saved.o; if (saved.r === undefined) delete process.env.APP_ROOT_HOST; else process.env.APP_ROOT_HOST = saved.r; });

describe("normaliseDomain", () => {
  it("accepts what people actually type", () => {
    expect(normaliseDomain("Book.Northline.co.uk")).toEqual({ ok: true, domain: "book.northline.co.uk" });
    expect(normaliseDomain("https://book.northline.co.uk/")).toEqual({ ok: true, domain: "book.northline.co.uk" });
    expect(normaliseDomain("  northline.co.uk. ")).toEqual({ ok: true, domain: "northline.co.uk" });
    expect(normaliseDomain("http://www.northline.com:8080/book?x=1")).toEqual({ ok: true, domain: "www.northline.com" });
  });
  it("refuses things that aren't a domain the shop owns", () => {
    for (const bad of ["", "northline", "no spaces.co.uk", "a..b.co.uk", "-x.co.uk", "foliyo.co.uk", "demo.foliyo.co.uk", "mine.vercel.app", "x.localhost", "1.2.3.4"])
      expect(normaliseDomain(bad).ok, bad).toBe(false);
  });
});

describe("toCustomerDomain: customers' links move, the team's never do", () => {
  const fix = (t: string) => toCustomerDomain(t, "northline", "book.northline.co.uk", "https://foliyo.co.uk");
  it("moves the shop page, booking, account, manage, offer, pay and unsubscribe links", () => {
    const from = "https://northline.foliyo.co.uk";
    expect(fix(`${from}`)).toBe("https://book.northline.co.uk");
    expect(fix(`${from}/`)).toBe("https://book.northline.co.uk/");
    expect(fix(`${from}/book`)).toBe("https://book.northline.co.uk/book");
    expect(fix(`${from}/book?service=1&staff=2`)).toBe("https://book.northline.co.uk/book?service=1&staff=2");
    expect(fix(`${from}/me?visit=abc`)).toBe("https://book.northline.co.uk/me?visit=abc");
    expect(fix(`${from}/manage/tok123`)).toBe("https://book.northline.co.uk/manage/tok123");
    expect(fix(`${from}/offer/tok`)).toBe("https://book.northline.co.uk/offer/tok");
    expect(fix(`${from}/pay/p1`)).toBe("https://book.northline.co.uk/pay/p1");
    expect(fix(`${from}/u/c/abcdefgh1234`)).toBe("https://book.northline.co.uk/u/c/abcdefgh1234");
    expect(fix(`<a href="${from}/book">Book</a> or <a href="${from}">visit</a>`)).toBe(`<a href="https://book.northline.co.uk/book">Book</a> or <a href="https://book.northline.co.uk">visit</a>`);
  });
  it("leaves staff links, other shops and look-alikes alone", () => {
    const from = "https://northline.foliyo.co.uk";
    for (const keep of [`${from}/workspace`, `${from}/workspace?invite=t`, `${from}/signin`, `${from}/verify?token=t`, `${from}/reset?token=t`, `${from}/booking`, `${from}/menu`,
      "https://other.foliyo.co.uk/book", "https://northline.foliyo.co.uk.evil.test/book", "https://notnorthline.foliyo.co.uk/book"])
      expect(fix(keep), keep).toBe(keep);
  });
  it("does nothing without a live domain", () => {
    expect(toCustomerDomain("https://northline.foliyo.co.uk/book", "northline", null, "")).toBe("https://northline.foliyo.co.uk/book");
  });
});

describe("routeByHost with a shop's own domain", () => {
  const custom = {
    slugByHost: async (h: string) => (h === "book.northline.co.uk" ? "northline" : null),
    domainBySlug: async (s: string) => (s === "northline" ? "book.northline.co.uk" : null),
  };
  const none = async () => false;
  const get = (url: string, headers: Record<string, string> = {}, method = "GET") => new Request(url, { method, headers });
  const go = (r: Request) => routeByHost(r, none, custom);

  it("serves the shop on its own domain, tagged as a custom host", async () => {
    const out = (await go(get("https://book.northline.co.uk/book"))) as Request;
    expect(out).toBeInstanceOf(Request);
    expect(new URL(out.url).pathname).toBe("/book/northline");
    expect(out.headers.get("x-foliyo-shop-host")).toBe("northline");
    expect(out.headers.get("x-foliyo-custom-host")).toBe("book.northline.co.uk");
    expect(new URL(((await go(get("https://book.northline.co.uk/"))) as Request).url).pathname).toBe("/northline");
    expect(new URL(((await go(get("https://book.northline.co.uk/api/public/shops/northline"))) as Request).url).pathname).toBe("/api/public/shops/northline");
  });
  it("can't be tricked by a client-supplied custom-host header", async () => {
    const out = (await go(get("https://northline.foliyo.co.uk/api/x", { "x-foliyo-custom-host": "evil.test" }))) as Request;
    expect(out.headers.get("x-foliyo-custom-host")).toBeNull();
  });
  it("team pages stay on the foliyo address", async () => {
    for (const p of ["/workspace", "/signin", "/staff", "/forgot", "/reset?token=t", "/verify?token=t"]) {
      const res = (await go(get(`https://book.northline.co.uk${p}`))) as Response;
      expect(res.status, p).toBe(302);
      expect(res.headers.get("location"), p).toBe(`https://northline.foliyo.co.uk${p}`);
    }
  });
  it("moves the shop's foliyo customer pages to its own domain (GET only)", async () => {
    const r = (await go(get("https://northline.foliyo.co.uk/book?service=1"))) as Response;
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe("https://book.northline.co.uk/book?service=1");
    expect(((await go(get("https://northline.foliyo.co.uk/manage/abc"))) as Response).headers.get("location")).toBe("https://book.northline.co.uk/manage/abc");
    // staff, APIs and writes are untouched
    expect((await go(get("https://northline.foliyo.co.uk/workspace"))) as Request).toBeInstanceOf(Request);
    expect((await go(get("https://northline.foliyo.co.uk/api/app/workspace"))) as Request).toBeInstanceOf(Request);
    expect((await go(get("https://northline.foliyo.co.uk/book", {}, "POST"))) as Request).toBeInstanceOf(Request);
  });
  it("a shop without a live domain is served on its foliyo address as before", async () => {
    const out = (await routeByHost(get("https://northline.foliyo.co.uk/book"), none, { slugByHost: async () => null, domainBySlug: async () => null })) as Request;
    expect(new URL(out.url).pathname).toBe("/book/northline");
    expect(out.headers.get("x-foliyo-custom-host")).toBeNull();
  });
  it("an unknown domain gets the platform, never somebody's shop", async () => {
    const out = (await go(get("https://evil.example.com/book"))) as Request;
    expect(new URL(out.url).pathname).toBe("/book");
    expect(out.headers.get("x-foliyo-shop-host")).toBeNull();
  });
  it("the root host's old /<slug> links go to the shop's own domain once it is live", async () => {
    const r = (await routeByHost(get("https://foliyo.co.uk/northline"), async (s) => s === "northline", custom)) as Response;
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe("https://book.northline.co.uk/");
  });
});
