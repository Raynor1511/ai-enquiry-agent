import { describe, expect, it } from "vitest";
import { findCustomer } from "../src/tools/findCustomer.js";
import { getServices } from "../src/tools/getServices.js";
import { checkServiceArea } from "../src/tools/checkServiceArea.js";
import { ToolInputError } from "../src/tools/deps.js";
import { depsAt } from "./helpers.js";

describe("find_customer", () => {
  it("verifies a customer by email, case-insensitively, with recent jobs first", async () => {
    const result = await findCustomer(await depsAt(), { email: "  Margaret.Ellis@EXAMPLE.co.uk " });
    expect(result).toMatchObject({ found: true, verified: true, match_basis: "email" });
    const match = result.matches[0]!;
    expect(match).toMatchObject({ customer_id: "cus_001", name: "Margaret Ellis", postcode: "BS6 6AL", job_count: 3 });
    const jobs = match.recent_jobs as Array<{ date: string; service: string }>;
    expect(jobs[0]).toMatchObject({ date: "2026-03-17", service: "Annual gas boiler service" });
    expect(jobs.map((j) => j.date)).toEqual([...jobs.map((j) => j.date)].sort().reverse());
  });

  it("verifies a customer by phone in international format", async () => {
    const result = await findCustomer(await depsAt(), { phone: "+44 (0)7700 900102" });
    expect(result).toMatchObject({ verified: true, match_basis: "phone" });
    expect(result.matches[0]).toMatchObject({ customer_id: "cus_002", name: "David Okafor" });
  });

  it("falls back to phone when the email is unknown", async () => {
    const result = await findCustomer(await depsAt(), { email: "someone@example.org", phone: "0117 496 0129" });
    expect(result).toMatchObject({ verified: true, match_basis: "phone" });
    expect(result.matches[0]).toMatchObject({ customer_id: "cus_029" });
  });

  it("returns only masked details for a name-only match (identity not verified)", async () => {
    const result = await findCustomer(await depsAt(), { email: "margaret.records@example.net", name: "margaret ellis" });
    expect(result).toMatchObject({ found: true, verified: false, match_basis: "name" });
    expect(result.matches[0]).toEqual({
      customer_id: "cus_001",
      name: "Margaret Ellis",
      customer_type: "residential",
      district: "BS6",
      email_on_file: "m*************@example.co.uk",
      phone_on_file: "ending 101",
    });
    const text = JSON.stringify(result);
    for (const secret of ["Cotham", "6AL", "0117 496 0101", "margaret.ellis@", "Worcester", "INV-"]) {
      expect(text).not.toContain(secret);
    }
    expect(result.guidance).toMatch(/NOT verified/);
  });

  it("matches company names, also without verification", async () => {
    const result = await findCustomer(await depsAt(), { name: "Bristol Harbour Lettings" });
    expect(result).toMatchObject({ verified: false, match_basis: "name" });
    expect(result.matches[0]).toMatchObject({ customer_id: "cus_010" });
  });

  it("refuses single-word name searches so customers cannot be enumerated", async () => {
    const result = await findCustomer(await depsAt(), { name: "Margaret" });
    expect(result).toMatchObject({ found: false, matches: [] });
    expect(result.guidance).toMatch(/full name/);
  });

  it("reports a new customer when nothing matches", async () => {
    const result = await findCustomer(await depsAt(), { email: "new.person@example.com", name: "New Person" });
    expect(result).toMatchObject({ found: false, verified: false, match_basis: null, matches: [] });
  });

  it("requires at least one identifier", async () => {
    await expect(findCustomer(await depsAt(), { email: " ", name: "" })).rejects.toBeInstanceOf(ToolInputError);
  });
});

describe("get_services", () => {
  it("ranks the boiler service first for a service request and quotes the exact price", async () => {
    const result = await getServices(await depsAt(), { query: "How much to service my boiler?" });
    expect(result.matched).toBe(true);
    expect(result.services[0]).toMatchObject({ id: "svc_boiler_service", price_display: "£95", price_basis: "fixed" });
  });

  it.each([
    ["water leaking from the pipe under my kitchen sink", "svc_leak_repair"],
    ["we'd like a new bathroom with a walk-in shower", "svc_bathroom_refit"],
    ["my boiler is making a banging noise", "svc_boiler_repair"],
    ["need a CP12 for my rental flat", "svc_gas_safety_cert"],
    ["toilet keeps running all night", "svc_toilet_repair"],
    ["radiators cold at the bottom, think we need a flush", "svc_power_flush"],
    ["pipe has burst and the kitchen is flooding", "svc_burst_pipe"],
  ])("matches %j to %s", async (query, expected) => {
    const result = await getServices(await depsAt(), { query });
    expect(result.services[0]?.id).toBe(expected);
  });

  it("includes the emergency call-out alongside a burst pipe", async () => {
    const result = await getServices(await depsAt(), { query: "emergency! pipe burst, water pouring through the ceiling" });
    const ids = result.services.map((s) => s.id);
    expect(ids).toContain("svc_burst_pipe");
    expect(ids).toContain("svc_emergency_callout");
    expect(result.services.find((s) => s.id === "svc_emergency_callout")?.price_display).toBe("from £120");
  });

  it("returns general policies plus those for the matched categories only", async () => {
    const result = await getServices(await depsAt(), { query: "new bathroom" });
    const ids = result.policies.map((p) => p.id);
    expect(ids).toContain("pol_bathrooms");
    expect(ids).toContain("pol_cancellation");
    expect(ids).not.toContain("pol_landlords");
    expect(ids).not.toContain("pol_boiler_installs");
  });

  it("falls back to the full price list when nothing matches, without inventing anything", async () => {
    const deps = await depsAt();
    const all = await deps.store.listServices();
    const result = await getServices(deps, { query: "can you fix my car" });
    expect(result.matched).toBe(false);
    expect(result.services).toHaveLength(all.length);
    expect(result.note).toMatch(/do not invent a price/);
  });

  it("fetches services by id, by category, and without policies", async () => {
    const deps = await depsAt();
    const byId = await getServices(deps, { service_ids: ["svc_power_flush", "svc_nope"], include_policies: false });
    expect(byId.services.map((s) => s.id)).toEqual(["svc_power_flush"]);
    expect(byId.policies).toEqual([]);
    expect(byId.note).toContain("svc_nope");

    const gas = await getServices(deps, { category: "gas" });
    expect(gas.services.every((s) => s.category === "gas")).toBe(true);
    expect(gas.policies.map((p) => p.id)).toContain("pol_landlords");
  });

  it("formats large ranges with thousands separators", async () => {
    const result = await getServices(await depsAt(), { service_ids: ["svc_boiler_install"] });
    expect(result.services[0]?.price_display).toBe("£2,400–£3,800");
  });
});

describe("check_service_area", () => {
  it("covers core districts with no travel charge", async () => {
    const result = await checkServiceArea(await depsAt(), { postcode: "bs66al" });
    expect(result).toMatchObject({ valid: true, postcode: "BS6 6AL", district: "BS6", covered: true, zone: "core", travel_surcharge: 0, emergency_response_target_minutes: 120 });
  });

  it("covers extended districts with the £25 travel charge", async () => {
    const result = await checkServiceArea(await depsAt(), { postcode: "BS31 2JA" });
    expect(result).toMatchObject({ covered: true, zone: "extended", travel_surcharge: 25, area_name: "Keynsham" });
    expect(result.message).toContain("£25 travel charge");
  });

  it.each(["BA1 1LZ", "BS22 7XX", "GL12 8AA", "SW1A 1AA"])("does not cover %s", async (postcode) => {
    const result = await checkServiceArea(await depsAt(), { postcode });
    expect(result).toMatchObject({ valid: true, covered: false, zone: null });
    expect(result.message).toMatch(/outside our service area/);
  });

  it("accepts a district on its own", async () => {
    const result = await checkServiceArea(await depsAt(), { postcode: "BS16" });
    expect(result).toMatchObject({ valid: true, covered: true, district: "BS16" });
  });

  it("flags invalid postcodes instead of guessing", async () => {
    const result = await checkServiceArea(await depsAt(), { postcode: "near the docks" });
    expect(result).toMatchObject({ valid: false, covered: null });
    expect(result.message).toMatch(/confirm their postcode/);
  });
});

describe("phase 2 acceptance: returning customer + boiler service price", () => {
  it.each([
    ["margaret.ellis@example.co.uk", "cus_001", 0],
    ["rob.marsh@example.com", "cus_008", 25],
  ])("%s gets the right customer, price and travel charge", async (email, customerId, surcharge) => {
    const deps = await depsAt();
    const customer = await findCustomer(deps, { email });
    expect(customer).toMatchObject({ verified: true });
    expect(customer.matches[0]).toMatchObject({ customer_id: customerId });

    const area = await checkServiceArea(deps, { postcode: customer.matches[0]!.postcode as string });
    expect(area.travel_surcharge).toBe(surcharge);

    const services = await getServices(deps, { query: "boiler service" });
    expect(services.services[0]).toMatchObject({ id: "svc_boiler_service", price_min: 95 });
  });
});
