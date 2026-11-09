#!/usr/bin/env node
// Spawns the built server over stdio (exactly as Claude Desktop / Claude Code do) and asks the
// Phase 2 acceptance question with real tool calls:
//   "Is this a returning customer, and what would a boiler service cost them?"
// Run: npm run build && npm run demo [-- email@example.com]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const email = process.argv[2] ?? "rob.marsh@example.com";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(here, "..", "dist", "index.js")],
  env: { ...process.env, LOG_LEVEL: "warn" },
});
const client = new Client({ name: "demo", version: "1.0.0" });
await client.connect(transport);

const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  return JSON.parse(res.content[0].text);
};

const { tools } = await client.listTools();
console.log(`Connected. Tools: ${tools.map((t) => t.name).join(", ")}\n`);
console.log(`Q: Is ${email} a returning customer, and what would a boiler service cost them?\n`);

const customer = await call("find_customer", { email });
if (!customer.found) {
  console.log("Not a returning customer.");
} else {
  const c = customer.matches[0];
  console.log(`✓ Returning customer: ${c.name} (${c.customer_id}), since ${c.customer_since}, ${c.job_count} past jobs`);
  for (const j of c.recent_jobs.slice(0, 3)) console.log(`    ${j.date}  ${j.service}  £${j.amount}`);

  const area = await call("check_service_area", { postcode: c.postcode });
  console.log(`✓ ${c.postcode}: ${area.message}`);

  const services = await call("get_services", { query: "annual boiler service", include_policies: false, limit: 1 });
  const s = services.services[0];
  const total = s.price_min + (area.travel_surcharge ?? 0);
  console.log(`✓ ${s.name}: ${s.price_display} (${s.price_note})`);
  console.log(`\nA: Yes. A boiler service would cost them £${total}${area.travel_surcharge ? ` (£${s.price_min} + £${area.travel_surcharge} travel)` : ""}.`);

  const slots = await call("get_available_slots", { max_results: 3 });
  console.log(`   Next free windows: ${slots.slots.map((x) => x.label).join("; ")}`);
}

await client.close();
