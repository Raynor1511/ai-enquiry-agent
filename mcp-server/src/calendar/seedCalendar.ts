import { DateTime } from "luxon";
import type { BusyInterval, CalendarProvider, CalendarTemplate, TemplateBooking } from "./types.js";

const SATURDAY = 6;
const SUNDAY = 7;

function at(day: DateTime, hhmm: string): DateTime {
  const [h, m] = hhmm.split(":").map(Number);
  return day.set({ hour: h ?? 0, minute: m ?? 0, second: 0, millisecond: 0 });
}

/**
 * Turn the relative booking template into concrete busy intervals around `now`.
 * Exported so the Google Calendar seeding script creates exactly the same events.
 */
export function materialiseBookings(
  template: CalendarTemplate,
  now: DateTime,
): Array<BusyInterval & { title: string }> {
  const today = now.setZone(template.timezone).startOf("day");
  const closed = new Set(template.closed_dates);

  // Working weekdays from today onwards (index 0 = today or the next working weekday).
  const businessDays: DateTime[] = [];
  const saturdays: DateTime[] = [];
  for (let i = 0; businessDays.length < 40 && i < 90; i++) {
    const day = today.plus({ days: i });
    const iso = day.toISODate()!;
    if (closed.has(iso)) continue;
    if (day.weekday === SATURDAY && i > 0) saturdays.push(day);
    else if (day.weekday !== SATURDAY && day.weekday !== SUNDAY) businessDays.push(day);
  }

  const result: Array<BusyInterval & { title: string }> = [];
  for (const booking of template.bookings) {
    const day = dayFor(booking, businessDays, saturdays);
    if (!day) continue;
    result.push({ start: at(day, booking.start), end: at(day, booking.end), title: booking.title });
  }
  return result.sort((a, b) => a.start.toMillis() - b.start.toMillis());
}

function dayFor(b: TemplateBooking, businessDays: DateTime[], saturdays: DateTime[]): DateTime | undefined {
  if ("business_day" in b) return businessDays[b.business_day];
  return saturdays[b.saturday - 1];
}

/** Busy time from the seed template. The template is re-anchored to the current day on every call. */
export class SeedCalendarProvider implements CalendarProvider {
  constructor(
    private readonly template: CalendarTemplate,
    private readonly now: () => DateTime,
  ) {}

  async getBusy(from: DateTime, to: DateTime): Promise<BusyInterval[]> {
    return materialiseBookings(this.template, this.now())
      .filter((b) => b.end > from && b.start < to)
      .map(({ start, end }) => ({ start, end }));
  }
}
