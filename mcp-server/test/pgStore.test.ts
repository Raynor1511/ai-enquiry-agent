/**
 * Postgres parity and safety tests. Skipped unless TEST_DATABASE_URL points at a database
 * loaded with seed/sql/001-003 and connects AS THE mcp_readonly ROLE. See docs/testing.md:
 *   TEST_DATABASE_URL=postgres://mcp_readonly:<pw>@localhost:55432/harbourline npm test
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { PgDataStore } from "../src/data/pgStore.js";
import { findCustomer } from "../src/tools/findCustomer.js";
import { getServices } from "../src/tools/getServices.js";
import { checkServiceArea } from "../src/tools/checkServiceArea.js";
import { getAvailableSlots } from "../src/tools/getAvailableSlots.js";
import { depsAt } from "./helpers.js";
import type { ToolDeps } from "../src/tools/deps.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PgDataStore (needs TEST_DATABASE_URL)", () => {
  let pgStore: PgDataStore;
  let json: ToolDeps;
  let viaPg: ToolDeps;

  beforeAll(async () => {
    pgStore = new PgDataStore({ connectionString: url! });
    json = await depsAt();
    viaPg = await depsAt(undefined, pgStore);
  });
  afterAll(async () => {
    await pgStore?.close();
  });

  const cases: Array<[string, (d: ToolDeps) => Promise<unknown>]> = [
    ["find_customer by email", (d) => findCustomer(d, { email: "Margaret.Ellis@example.co.uk" })],
    ["find_customer by phone", (d) => findCustomer(d, { phone: "+44 7700 900102" })],
    ["find_customer agency (many jobs)", (d) => findCustomer(d, { email: "maintenance@harbour-lettings.example" })],
    ["find_customer by name (masked)", (d) => findCustomer(d, { name: "Grace O'Neill" })],
    ["find_customer by company", (d) => findCustomer(d, { name: "the mill cafe" })],
    ["find_customer unknown", (d) => findCustomer(d, { email: "nobody@example.com" })],
    ["get_services query", (d) => getServices(d, { query: "leaking pipe under the sink" })],
    ["get_services full list", (d) => getServices(d, {})],
    ["get_services by id", (d) => getServices(d, { service_ids: ["svc_emergency_callout", "svc_bathroom_refit"] })],
    ["check_service_area core", (d) => checkServiceArea(d, { postcode: "BS6 6AL" })],
    ["check_service_area extended", (d) => checkServiceArea(d, { postcode: "bs20 7hu" })],
    ["check_service_area outside", (d) => checkServiceArea(d, { postcode: "BA1 1LZ" })],
    ["get_available_slots", (d) => getAvailableSlots(d, { days: 14, max_results: 20 })],
  ];

  it.each(cases)("%s returns the same result as the JSON store", async (_name, run) => {
    expect(await run(viaPg)).toEqual(await run(json));
  });

  describe("read-only guarantees", () => {
    let client: pg.Client;
    beforeAll(async () => {
      client = new pg.Client({ connectionString: url });
      await client.connect();
    });
    afterAll(async () => {
      await client?.end();
    });

    it("connects as the mcp_readonly role", async () => {
      const { rows } = await client.query("select current_user");
      expect(rows[0].current_user).toBe("mcp_readonly");
    });

    it.each([
      ["insert", "insert into customers (first_name, last_name) values ('Evil', 'Mallory')"],
      ["update", "update services set price_min = 1 where id = 'svc_boiler_service'"],
      ["delete", "delete from jobs"],
      ["create", "create table hacked (id int)"],
    ])("cannot %s", async (_op, sql) => {
      await expect(client.query(sql)).rejects.toThrow(/permission denied/);
    });

    it.each(["enquiries", "drafts", "approvals", "audit_log"])("cannot read pipeline table %s", async (table) => {
      await expect(client.query(`select * from ${table} limit 1`)).rejects.toThrow(/permission denied/);
    });
  });
});
