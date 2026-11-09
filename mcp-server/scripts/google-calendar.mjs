#!/usr/bin/env node
// Google Calendar helper for the demo calendar (GOOGLE_CALENDAR_ID in ../.env).
//   seed   Replace this script's demo bookings with the template in seed/data/calendar.json,
//          anchored to today. Re-run whenever the next two weeks should look fresh.
//          Only events this script created (private tag harbourlineSeed=1) are ever deleted.
//   check  Using the MCP server's READ-ONLY token: read the calendar and free/busy, and prove
//          that creating an event is refused.
// Run: npm run build && node scripts/google-calendar.mjs seed|check
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DateTime } from "luxon";
import { readEnv } from "../../scripts/lib/dotenv.mjs";
import {
  CALENDAR_EVENTS,
  CALENDAR_READONLY,
  loadServiceAccountKey,
  ServiceAccountTokenSource,
} from "../dist/calendar/googleAuth.js";
import { GoogleCalendarProvider } from "../dist/calendar/googleCalendar.js";
import { materialiseBookings } from "../dist/calendar/seedCalendar.js";
import { loadCalendarTemplate } from "../dist/data/seedFiles.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const API = "https://www.googleapis.com/calendar/v3";
const SEED_TAG = "harbourlineSeed";

const env = readEnv();
const calendarId = env.GOOGLE_CALENDAR_ID;
const keyFile = env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
if (!calendarId || !keyFile) {
  console.error("GOOGLE_CALENDAR_ID and GOOGLE_SERVICE_ACCOUNT_KEY_FILE must be set in .env");
  process.exit(1);
}
const key = await loadServiceAccountKey(keyFile);
const template = await loadCalendarTemplate(path.resolve(here, "..", "..", "seed", "data"));
const cal = encodeURIComponent(calendarId);

async function google(tokens, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${await tokens.token()}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

async function seed() {
  const tokens = new ServiceAccountTokenSource(key, CALENDAR_EVENTS);
  const now = DateTime.now().setZone(template.timezone);

  // Remove earlier seed events (only ours, identified by the private tag).
  const old = [];
  let pageToken;
  do {
    const q = new URLSearchParams({
      privateExtendedProperty: `${SEED_TAG}=1`,
      timeMin: now.minus({ days: 60 }).toUTC().toISO(),
      timeMax: now.plus({ days: 90 }).toUTC().toISO(),
      maxResults: "250",
      singleEvents: "true",
      ...(pageToken ? { pageToken } : {}),
    });
    const res = await google(tokens, "GET", `${API}/calendars/${cal}/events?${q}`);
    if (res.status !== 200) throw new Error(`Listing events failed (${res.status}): ${res.body.error?.message ?? ""}`);
    old.push(...(res.body.items ?? []));
    pageToken = res.body.nextPageToken;
  } while (pageToken);
  for (const ev of old) await google(tokens, "DELETE", `${API}/calendars/${cal}/events/${ev.id}`);
  console.log(`  removed ${old.length} earlier demo bookings`);

  const bookings = materialiseBookings(template, now).filter((b) => b.end > now);
  for (const b of bookings) {
    const res = await google(tokens, "POST", `${API}/calendars/${cal}/events`, {
      summary: b.title,
      description: "Demo booking for the fictional Harbourline Plumbing & Heating.",
      start: { dateTime: b.start.toISO(), timeZone: template.timezone },
      end: { dateTime: b.end.toISO(), timeZone: template.timezone },
      transparency: "opaque",
      extendedProperties: { private: { [SEED_TAG]: "1" } },
    });
    if (res.status !== 200) throw new Error(`Creating "${b.title}" failed (${res.status}): ${res.body.error?.message ?? ""}`);
  }
  const first = bookings[0]?.start.toFormat("ccc d LLL");
  const last = bookings.at(-1)?.start.toFormat("ccc d LLL");
  console.log(`  created ${bookings.length} demo bookings (${first} to ${last})`);
}

async function check() {
  const tokens = new ServiceAccountTokenSource(key, CALENDAR_READONLY);
  console.log(`  service account: ${tokens.email} (scope: calendar.readonly)`);

  const meta = await google(tokens, "GET", `${API}/calendars/${cal}`);
  if (meta.status !== 200) throw new Error(`Reading the calendar failed (${meta.status}): ${meta.body.error?.message ?? ""}. Is it shared with the service account?`);
  console.log(`  ✓ can read calendar "${meta.body.summary}" (time zone ${meta.body.timeZone})`);
  if (meta.body.timeZone !== template.timezone) {
    console.log(`  ! calendar time zone should be ${template.timezone}: change it in the calendar's settings`);
  }

  const provider = new GoogleCalendarProvider(calendarId, tokens, template.timezone);
  const now = DateTime.now().setZone(template.timezone);
  const busy = await provider.getBusy(now.startOf("day"), now.plus({ days: 14 }));
  console.log(`  ✓ free/busy works: ${busy.length} busy blocks in the next 14 days`);

  const attempt = await google(tokens, "POST", `${API}/calendars/${cal}/events`, {
    summary: "Should never be created",
    start: { dateTime: now.plus({ days: 1 }).toISO() },
    end: { dateTime: now.plus({ days: 1, hours: 1 }).toISO() },
  });
  if (attempt.status === 200) {
    await google(new ServiceAccountTokenSource(key, CALENDAR_EVENTS), "DELETE", `${API}/calendars/${cal}/events/${attempt.body.id}`);
    throw new Error("The read-only token was able to create an event: it is NOT read-only");
  }
  console.log(`  ✓ creating an event with the read-only token is refused (HTTP ${attempt.status})`);
}

const command = process.argv[2];
try {
  if (command === "seed") await seed();
  else if (command === "check") await check();
  else {
    console.error("Usage: node scripts/google-calendar.mjs seed|check");
    process.exit(1);
  }
} catch (err) {
  console.error(`  ✗ ${err.message}`);
  process.exit(1);
}
