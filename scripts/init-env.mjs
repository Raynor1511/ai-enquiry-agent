#!/usr/bin/env node
// Creates or updates .env from .env.example without touching values you've already set:
//  - adds any keys from .env.example that .env is missing (blank)
//  - generates random values for the secrets below if they are empty
// It prints key NAMES only, never values. Safe to re-run.
// Run: node scripts/init-env.mjs
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const examplePath = path.join(root, ".env.example");
const envPath = path.join(root, ".env");

const GENERATED = { MCP_AUTH_TOKEN: 32, N8N_ENCRYPTION_KEY: 32, TEST_WEBHOOK_KEY: 32, DEMO_N8N_KEY: 32 }; // bytes of randomness, hex-encoded

const KEY_LINE = /^\s*([A-Z0-9_]+)\s*=(.*)$/;
const keysIn = (text) => text.split(/\r?\n/).map((l) => KEY_LINE.exec(l)?.[1]).filter(Boolean);

const example = readFileSync(examplePath, "utf8");
const created = !existsSync(envPath);
let lines = (created ? example : readFileSync(envPath, "utf8")).split(/\r?\n/);
const eol = !created && readFileSync(envPath, "utf8").includes("\r\n") ? "\r\n" : "\n";

// Template defaults (e.g. DATA_SOURCE=json) carry over; secrets in the template are always blank.
const defaults = new Map(
  example.split(/\r?\n/).map((l) => KEY_LINE.exec(l)).filter(Boolean).map((m) => [m[1], m[2].trim()]),
);
const present = new Set(keysIn(lines.join("\n")));
const added = keysIn(example).filter((k) => !present.has(k));
if (added.length) {
  while (lines.length && lines.at(-1) === "") lines.pop();
  lines.push("", "# --- Added by scripts/init-env.mjs (see .env.example for what these are) ---");
  for (const key of added) lines.push(`${key}=${defaults.get(key) ?? ""}`);
  lines.push("");
}

const generated = [];
lines = lines.map((line) => {
  const m = KEY_LINE.exec(line);
  if (!m) return line;
  const [, key, value] = m;
  if (key in GENERATED && value.trim() === "") {
    generated.push(key);
    return `${key}=${randomBytes(GENERATED[key]).toString("hex")}`;
  }
  return line;
});

writeFileSync(envPath, lines.join(eol));
console.log(created ? "Created .env from .env.example" : "Updated .env");
if (added.length && !created) console.log(`  added keys: ${added.join(", ")}`);
if (generated.length) console.log(`  generated: ${generated.join(", ")}`);

const missing = lines
  .map((l) => KEY_LINE.exec(l))
  .filter((m) => m && m[2].trim() === "")
  .map((m) => m[1]);
console.log(missing.length ? `  still empty: ${missing.join(", ")}` : "  all keys have values");
