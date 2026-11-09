import type { DateTime } from "luxon";
import type { AvailabilityRules, CalendarProvider } from "../calendar/types.js";
import type { BusinessDataStore } from "../data/types.js";

/** Everything a tool needs, injected so tests can supply fixed data and a fixed clock. */
export interface ToolDeps {
  store: BusinessDataStore;
  calendar: CalendarProvider;
  rules: AvailabilityRules;
  now: () => DateTime;
}

/** Thrown for bad input the caller can fix; shown to the model as a tool error message. */
export class ToolInputError extends Error {}
