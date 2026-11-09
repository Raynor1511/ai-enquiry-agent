import path from "node:path";
import { fileURLToPath } from "node:url";
import { DateTime } from "luxon";
import { SeedCalendarProvider } from "../src/calendar/seedCalendar.js";
import { JsonDataStore } from "../src/data/jsonStore.js";
import { loadSeedData, type SeedData } from "../src/data/seedFiles.js";
import type { BusinessDataStore } from "../src/data/types.js";
import type { ToolDeps } from "../src/tools/deps.js";

export const SEED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "seed", "data");

/** Monday 9 November 2026, 10:00 UK time (GMT). */
export const MONDAY_10AM = DateTime.fromISO("2026-11-09T10:00:00", { zone: "Europe/London" });

let cached: SeedData | undefined;
export async function seed(): Promise<SeedData> {
  cached ??= await loadSeedData(SEED_DIR);
  return cached;
}

export async function depsAt(now: DateTime = MONDAY_10AM, store?: BusinessDataStore): Promise<ToolDeps> {
  const data = await seed();
  const clock = () => now;
  return {
    store: store ?? new JsonDataStore(data),
    calendar: new SeedCalendarProvider(data.calendar, clock),
    rules: data.calendar,
    now: clock,
  };
}
