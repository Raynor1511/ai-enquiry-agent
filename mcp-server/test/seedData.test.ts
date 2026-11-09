import { describe, expect, it } from "vitest";
import { normaliseUkPhone } from "../src/domain/phone.js";
import { parseUkPostcode } from "../src/domain/postcode.js";
import { seed } from "./helpers.js";

/** The demo must never contain data that could belong to a real person. */
const RESERVED_EMAIL = /@([a-z0-9-]+\.)*(example(\.com|\.net|\.org|\.co\.uk)?|[a-z0-9-]+\.example)$/i;
/** Ofcom ranges reserved for TV/radio drama: 07700 900000-900999 and 0117 496 0000-0999. */
const DRAMA_PHONE = /^(07700900\d{3}|01174960\d{3})$/;

describe("seed data integrity", () => {
  it("has unique ids", async () => {
    const data = await seed();
    for (const list of [data.services, data.policies, data.customers, data.jobs]) {
      const ids = list.map((x) => x.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("has 15-20 services with sane prices and keywords", async () => {
    const { services } = await seed();
    expect(services.length).toBeGreaterThanOrEqual(15);
    expect(services.length).toBeLessThanOrEqual(20);
    for (const s of services) {
      expect(s.price_min).toBeGreaterThan(0);
      if (s.price_basis === "fixed") expect(s.price_max).toBe(s.price_min);
      if (s.price_basis === "range") expect(s.price_max!).toBeGreaterThan(s.price_min);
      expect(s.keywords.length).toBeGreaterThan(0);
    }
  });

  it("has about 30 customers with reserved emails, drama-range phones and valid postcodes", async () => {
    const { customers } = await seed();
    expect(customers.length).toBe(30);
    for (const c of customers) {
      expect(c.email, c.id).toMatch(RESERVED_EMAIL);
      expect(normaliseUkPhone(c.phone!), c.id).toMatch(DRAMA_PHONE);
      expect(parseUkPostcode(c.postcode!)?.inward, c.id).not.toBeNull();
    }
    const phones = customers.map((c) => normaliseUkPhone(c.phone!));
    expect(new Set(phones).size).toBe(phones.length);
  });

  it("only references customers and services that exist, and every customer has a job", async () => {
    const { jobs, customers, services } = await seed();
    const customerIds = new Set(customers.map((c) => c.id));
    const serviceIds = new Set(services.map((s) => s.id));
    for (const j of jobs) {
      expect(customerIds.has(j.customer_id), j.id).toBe(true);
      expect(serviceIds.has(j.service_id!), j.id).toBe(true);
    }
    for (const c of customers) {
      expect(jobs.some((j) => j.customer_id === c.id), c.id).toBe(true);
    }
  });

  it("puts every customer inside the service area", async () => {
    const { customers, districts } = await seed();
    const covered = new Set(districts.map((d) => d.district));
    for (const c of customers) {
      expect(covered.has(parseUkPostcode(c.postcode!)!.outward), c.id).toBe(true);
    }
  });

  it("has policies for every topic the agent needs", async () => {
    const { policies } = await seed();
    const categories = new Set(policies.map((p) => p.category));
    for (const needed of ["fees", "emergency", "hours", "area", "cancellation", "guarantee", "quotes", "payment", "complaints", "privacy"]) {
      expect(categories.has(needed), needed).toBe(true);
    }
  });
});
