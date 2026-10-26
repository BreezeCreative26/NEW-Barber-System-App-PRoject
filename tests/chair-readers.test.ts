import { describe, expect, it } from "vitest";
import { descriptorSuffix, parseAddress } from "../src/server/chair";

describe("reader location address", () => {
  it("reads a UK address with a postcode", () => {
    expect(parseAddress("14 High Street, Leeds, LS1 4AB", "Shop")).toEqual({ line1: "14 High Street", city: "Leeds", postal_code: "LS1 4AB", country: "GB" });
  });
  it("handles a postcode with no space and lower case", () => {
    expect(parseAddress("3 Mill Lane, Bristol bs16ab", "Shop")?.postal_code).toBe("BS1 6AB");
  });
  it("handles a postcode inside the same part as the street", () => {
    const a = parseAddress("22 Park Road M1 1AA", "Shop");
    expect(a?.postal_code).toBe("M1 1AA");
    expect(a?.line1).toBe("22 Park Road");
  });
  it("refuses an address with no postcode instead of inventing one", () => {
    expect(parseAddress("Somewhere in town", "Shop")).toBeNull();
    expect(parseAddress("", "Shop")).toBeNull();
  });
});

describe("card statement suffix", () => {
  it("is upper case, short and clean", () => {
    expect(descriptorSuffix("Northline Barbers & Co")).toBe("NORTHLINE BA");
    expect(descriptorSuffix("O'Neil's *Cuts*").includes("'")).toBe(false);
    expect(descriptorSuffix("Café Fade").length).toBeLessThanOrEqual(12);
  });
  it("is empty when there is no letter", () => {
    expect(descriptorSuffix("1234")).toBe("");
    expect(descriptorSuffix("")).toBe("");
  });
});
