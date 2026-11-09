import { DateTime } from "luxon";
import { CALENDAR_READONLY, loadServiceAccountKey, ServiceAccountTokenSource } from "./calendar/googleAuth.js";
import { GoogleCalendarProvider } from "./calendar/googleCalendar.js";
import { SeedCalendarProvider } from "./calendar/seedCalendar.js";
import type { CalendarProvider, CalendarTemplate } from "./calendar/types.js";
import type { Config } from "./config.js";
import { JsonDataStore } from "./data/jsonStore.js";
import { PgDataStore } from "./data/pgStore.js";
import { loadCalendarTemplate, loadSeedData } from "./data/seedFiles.js";
import type { BusinessDataStore } from "./data/types.js";
import type { ToolDeps } from "./tools/deps.js";

async function buildCalendar(config: Config, template: CalendarTemplate, now: () => DateTime): Promise<CalendarProvider> {
  if (config.calendarSource === "google") {
    const key = await loadServiceAccountKey(config.googleServiceAccountKeyFile!);
    // Read-only scope: this server can never create, change or delete calendar events.
    const tokens = new ServiceAccountTokenSource(key, CALENDAR_READONLY);
    return new GoogleCalendarProvider(config.googleCalendarId!, tokens, template.timezone);
  }
  return new SeedCalendarProvider(template, now);
}

/** Build the real dependencies from configuration. */
export async function buildDeps(config: Config): Promise<ToolDeps> {
  const fixed = config.fixedNow ? DateTime.fromISO(config.fixedNow, { setZone: true }) : null;
  if (fixed && !fixed.isValid) throw new Error(`FIXED_NOW is not a valid ISO timestamp: ${config.fixedNow}`);
  const now = () => fixed ?? DateTime.now();

  let store: BusinessDataStore;
  let template: CalendarTemplate;
  if (config.dataSource === "postgres") {
    template = await loadCalendarTemplate(config.seedDataDir);
    store = new PgDataStore({ connectionString: config.databaseUrl!, ssl: config.databaseSsl });
  } else {
    const seed = await loadSeedData(config.seedDataDir);
    template = seed.calendar;
    store = new JsonDataStore(seed);
  }

  return { store, calendar: await buildCalendar(config, template, now), rules: template, now };
}
