import { describe, expect, it } from "vitest";
import { parseUkPostcode } from "../src/domain/postcode.js";
import { normaliseUkPhone } from "../src/domain/phone.js";
import { contentStems, nameKey, stem } from "../src/domain/text.js";
import { formatGbp, maskEmail, maskPhone, priceDisplay } from "../src/domain/format.js";

describe("parseUkPostcode", () => {
  it.each([
    ["BS6 6AL", "BS6 6AL", "BS6"],
    ["bs66al", "BS6 6AL", "BS6"],
    ["  bs16 3ja ", "BS16 3JA", "BS16"],
    ["BS163JA", "BS16 3JA", "BS16"],
    ["BS1 6AL", "BS1 6AL", "BS1"],
    ["EC1A 1BB", "EC1A 1BB", "EC1A"],
    ["BA1 1LZ", "BA1 1LZ", "BA1"],
  ])("parses %s", (input, normalised, outward) => {
    const parsed = parseUkPostcode(input);
    expect(parsed?.normalised).toBe(normalised);
    expect(parsed?.outward).toBe(outward);
  });

  it("accepts an outward code on its own", () => {
    expect(parseUkPostcode("bs6")).toEqual({ normalised: "BS6", outward: "BS6", inward: null });
  });

  it.each(["", "hello", "12345", "BS6 6A", "BS6 6ALX", "B$$$", "SW1A 1AAA"])("rejects %j", (input) => {
    expect(parseUkPostcode(input)).toBeNull();
  });
});

describe("normaliseUkPhone", () => {
  it.each([
    ["07700 900102", "07700900102"],
    ["+44 7700 900102", "07700900102"],
    ["+44 (0)7700 900102", "07700900102"],
    ["0044 7700 900102", "07700900102"],
    ["(0117) 496-0101", "01174960101"],
    ["447700900102", "07700900102"],
  ])("normalises %s", (input, expected) => {
    expect(normaliseUkPhone(input)).toBe(expected);
  });

  it.each(["", "999", "call me", "123456789012345"])("rejects %j", (input) => {
    expect(normaliseUkPhone(input)).toBeNull();
  });
});

describe("text helpers", () => {
  it("builds name keys that ignore case, punctuation and spacing", () => {
    expect(nameKey("  Grace   O'Neill ")).toBe("grace oneill");
    expect(nameKey("The Mill Café")).toBe("the mill café");
  });

  it("stems plurals and -ing forms", () => {
    expect(stem("leaking")).toBe("leak");
    expect(stem("radiators")).toBe("radiator");
    expect(stem("boilers")).toBe("boiler");
    expect(stem("glass")).toBe("glass");
  });

  it("drops stopwords", () => {
    expect(contentStems("Hi, how much would it cost to service my boiler?")).toEqual(["service", "boiler"]);
  });
});

describe("formatting", () => {
  it("formats pounds", () => {
    expect(formatGbp(95)).toBe("£95");
    expect(formatGbp(2400)).toBe("£2,400");
    expect(formatGbp(12.5)).toBe("£12.50");
  });

  it("displays each price basis", () => {
    expect(priceDisplay({ price_basis: "fixed", price_min: 95, price_max: 95 })).toBe("£95");
    expect(priceDisplay({ price_basis: "range", price_min: 2400, price_max: 3800 })).toBe("£2,400–£3,800");
    expect(priceDisplay({ price_basis: "from", price_min: 120, price_max: null })).toBe("from £120");
  });

  it("masks contact details", () => {
    expect(maskEmail("margaret.ellis@example.co.uk")).toBe("m*************@example.co.uk");
    expect(maskEmail("ab@example.com")).toBe("a***@example.com");
    expect(maskPhone("0117 496 0101")).toBe("ending 101");
  });
});
