#!/usr/bin/env node
// Prints infra/slack-app-manifest.yml with the public host filled in (PUBLIC_HOST on the server, else the
// ngrok domain when running on a PC). No secrets involved.
// Run: node scripts/slack-manifest.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT, readEnv } from "./lib/dotenv.mjs";

const env = readEnv();
const host = env.PUBLIC_HOST || env.NGROK_DOMAIN;
if (!host) {
  console.error("Set PUBLIC_HOST (server) or NGROK_DOMAIN (PC) in .env");
  process.exit(1);
}
const template = readFileSync(path.join(ROOT, "infra", "slack-app-manifest.yml"), "utf8");
process.stdout.write(
  template
    .split(/\r?\n/)
    .filter((l) => !l.startsWith("#"))
    .join("\n")
    .replaceAll("{{PUBLIC_HOST}}", host)
    .trimStart(),
);
