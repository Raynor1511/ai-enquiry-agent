#!/usr/bin/env node
// Wraps .env values containing "$" in single quotes so Docker Compose doesn't treat "$..." as a
// variable (e.g. a database password with a dollar sign). Prints key names only. Safe to re-run.
// Run: node scripts/quote-env.mjs
import { readEnv, updateEnv, composeSafe, ENV_PATH } from "./lib/dotenv.mjs";
import { readFileSync } from "node:fs";

const rawValues = {};
for (const line of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line);
  if (m) rawValues[m[1]] = m[2].trim();
}
const values = readEnv();
const fix = {};
for (const [key, raw] of Object.entries(rawValues)) {
  if (raw.includes("$") && composeSafe(raw) !== raw) fix[key] = values[key];
  else if (raw.includes("$") && raw.includes("'") && !/^'.*'$/.test(raw)) {
    console.log(`  ! ${key} contains both $ and ' : change that value by hand (or avoid those characters)`);
  }
}
if (Object.keys(fix).length) {
  updateEnv(fix);
  console.log(`Quoted: ${Object.keys(fix).join(", ")}`);
} else {
  console.log("Nothing to quote.");
}
