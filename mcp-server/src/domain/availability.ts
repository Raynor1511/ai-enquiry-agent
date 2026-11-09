import { DateTime } from "luxon";
import type { AvailabilityRules, BusyInterval, WindowSpec } from "../calendar/types.js";

export type PartOfDay = "morning" | "afternoon" | "any";

export interface SlotQuery {
  /** First day to search, "YYYY-MM-DD" in business time. Defaults to today. */
  fromDate?: string;
  /** Number of calendar days to search from fromDate. */
  days: number;
  partOfDay: PartOfDay;
  includeSaturdays: boolean;
  maxResults: number;
}

export interface Slot {
  start: string;
  end: string;
  label: string;
}

export interface SlotSearch {
  /** The candidate windows to check, already filtered by rules and query, in time order. */
  candidates: Array<{ start: DateTime; end: DateTime }>;
  searchFrom: DateTime;
  searchTo: DateTime;
  /** Set when the requested range had to be clipped to the booking horizon. */
  clippedToHorizon: boolean;
}

function at(day: DateTime, hhmm: string): DateTime {
  const [h, m] = hhmm.split(":").map(Number);
  return day.set({ hour: h ?? 0, minute: m ?? 0, second: 0, millisecond: 0 });
}

function windowsFor(day: DateTime, rules: AvailabilityRules, includeSaturdays: boolean): WindowSpec[] {
  if (rules.closed_dates.includes(day.toISODate()!)) return [];
  if (day.weekday === 7) return rules.appointment_windows.sunday;
  if (day.weekday === 6) return includeSaturdays ? rules.appointment_windows.saturday : [];
  return rules.appointment_windows.weekday;
}

/** Work out which appointment windows to check for a query, before looking at the calendar. */
export function candidateWindows(rules: AvailabilityRules, query: SlotQuery, now: DateTime): SlotSearch {
  const zoneNow = now.setZone(rules.timezone);
  const today = zoneNow.startOf("day");
  const earliest = zoneNow.plus({ hours: rules.min_lead_hours });
  const horizonEnd = today.plus({ days: rules.horizon_days + 1 });

  let firstDay = today;
  if (query.fromDate) {
    const requested = DateTime.fromISO(query.fromDate, { zone: rules.timezone }).startOf("day");
    if (requested.isValid && requested > today) firstDay = requested;
  }
  const requestedEnd = firstDay.plus({ days: query.days });
  const lastDayExclusive = requestedEnd < horizonEnd ? requestedEnd : horizonEnd;

  const candidates: Array<{ start: DateTime; end: DateTime }> = [];
  for (let day = firstDay; day < lastDayExclusive; day = day.plus({ days: 1 })) {
    for (const [s, e] of windowsFor(day, rules, query.includeSaturdays)) {
      const start = at(day, s);
      const end = at(day, e);
      if (start < earliest) continue;
      if (query.partOfDay === "morning" && start.hour >= 12) continue;
      if (query.partOfDay === "afternoon" && start.hour < 12) continue;
      candidates.push({ start, end });
    }
  }

  return {
    candidates,
    searchFrom: firstDay,
    searchTo: lastDayExclusive,
    clippedToHorizon: requestedEnd > horizonEnd,
  };
}

/** Remove windows that overlap any busy interval and format the rest. */
export function freeSlots(
  candidates: Array<{ start: DateTime; end: DateTime }>,
  busy: BusyInterval[],
  maxResults: number,
): { slots: Slot[]; totalFree: number } {
  const free = candidates.filter((c) => !busy.some((b) => b.start < c.end && b.end > c.start));
  const slots = free.slice(0, maxResults).map(({ start, end }) => ({
    start: start.toISO({ suppressMilliseconds: true })!,
    end: end.toISO({ suppressMilliseconds: true })!,
    label: `${start.toFormat("ccc d LLL")}, ${start.toFormat("HH:mm")}–${end.toFormat("HH:mm")}`,
  }));
  return { slots, totalFree: free.length };
}
