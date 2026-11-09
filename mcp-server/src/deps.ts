import { DateTime } from "luxon";
import { SeedCalendarProvider } from "./calendar/seedCalendar.js";
import type { Config } from "./config.js";
import { JsonDataStore } from "./data/jsonStore.js";
import { PgDataStore } from "./data/pgStore.js";
import { loadCalendarTemplate, loadSeedData } from "./data/seedFiles.js";
import type { ToolDeps } from "./tools/deps.js";

/** Build the real dependencies from configuration. */
export async function buildDeps(config: Config): Promise<ToolDeps> {
  const fixed = config.fixedNow ? DateTime.fromISO(config.fixedNow, { setZone: true }) : null;
  if (fixed && !fixed.isValid) throw new Error(`FIXED_NOW is not a valid ISO timestamp: ${config.fixedNow}`);
  const now = () => fixed ?? DateTime.now();

  if (config.dataSource === "postgres") {
    const template = await loadCalendarTemplate(config.seedDataDir);
    return {
      store: new PgDataStore({ connectionString: config.databaseUrl!, ssl: config.databaseSsl }),
      calendar: new SeedCalendarProvider(template, now),
      rules: template,
      now,
    };
  }

  const seed = await loadSeedData(config.seedDataDir);
  return {
    store: new JsonDataStore(seed),
    calendar: new SeedCalendarProvider(seed.calendar, now),
    rules: seed.calendar,
    now,
  };
}
