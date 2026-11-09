#!/usr/bin/env node
// Prints infra/slack-app-manifest.yml with NGROK_DOMAIN from .env filled in (no secrets involved).
// Run: node scripts/slack-manifest.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT, readEnv } from "./lib/dotenv.mjs";

const { NGROK_DOMAIN } = readEnv();
if (!NGROK_DOMAIN) {
  console.error("NGROK_DOMAIN is empty in .env");
  process.exit(1);
}
const template = readFileSync(path.join(ROOT, "infra", "slack-app-manifest.yml"), "utf8");
process.stdout.write(
  template
    .split(/\r?\n/)
    .filter((l) => !l.startsWith("#"))
    .join("\n")
    .replaceAll("{{NGROK_DOMAIN}}", NGROK_DOMAIN)
    .trimStart(),
);
