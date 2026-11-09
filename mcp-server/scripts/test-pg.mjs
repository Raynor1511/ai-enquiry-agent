#!/usr/bin/env node
// Runs the Postgres parity/read-only test suite against the database in ../.env (DATABASE_URL,
// the mcp_readonly connection), without the URL ever appearing on screen.
// Run: npm run test:pg
import { spawnSync } from "node:child_process";
import { readEnv } from "../../scripts/lib/dotenv.mjs";

const env = readEnv();
if (!env.DATABASE_URL) {
  console.error("DATABASE_URL is empty in .env; run node scripts/db-setup.mjs first.");
  process.exit(1);
}
const result = spawnSync("npx", ["vitest", "run", "test/pgStore.test.ts"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, TEST_DATABASE_URL: env.DATABASE_URL },
});
process.exit(result.status ?? 1);
