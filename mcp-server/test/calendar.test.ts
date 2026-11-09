import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { materialiseBookings } from "../src/calendar/seedCalendar.js";
import { getAvailableSlots } from "../src/tools/getAvailableSlots.js";
import { ToolInputError } from "../src/tools/deps.js";
import { depsAt, MONDAY_10AM, seed } from "./helpers.js";

const london = (iso: string) => DateTime.fromISO(iso, { zone: "Europe/London" });

describe("materialiseBookings", () => {
  it("anchors business days to today when today is a weekday", async () => {
    const { calendar } = await seed();
    const bookings = materialiseBookings(calendar, MONDAY_10AM);
    const first = bookings[0]!;
    expect(first.start.toISO()).toBe("2026-11-09T08:00:00.000+00:00");
    // business_day 1 and 2 = Tue/Wed full-day installation
    expect(bookings.some((b) => b.start.toISODate() === "2026-11-10" && b.title.includes("day 1 of 2"))).toBe(true);
    // saturday 1 = Sat 14 Nov
    expect(bookings.some((b) => b.start.toISODate() === "2026-11-14")).toBe(true);
  });

  it("starts from Monday when today is a Sunday", async () => {
    const { calendar } = await seed();
    const bookings = materialiseBookings(calendar, london("2026-11-15T12:00"));
    expect(bookings[0]!.start.toISODate()).toBe("2026-11-16");
  });

  it("skips bank holidays when counting business days", async () => {
    const { calendar } = await seed();
    // Thu 24 Dec 2026: business_day 1 should skip Fri 25 Dec and Mon 28 Dec (substitute Boxing Day).
    const bookings = materialiseBookings(calendar, london("2026-12-24T09:00"));
    const days = new Set(bookings.map((b) => b.start.toISODate()));
    expect(days.has("2026-12-25")).toBe(false);
    expect(days.has("2026-12-28")).toBe(false);
    expect(days.has("2026-12-29")).toBe(true);
  });

  it("keeps local wall-clock times in British Summer Time", async () => {
    const { calendar } = await seed();
    const bookings = materialiseBookings(calendar, london("2027-06-07T09:00"));
    expect(bookings[0]!.start.toISO()).toBe("2027-06-07T08:00:00.000+01:00");
  });
});

describe("get_available_slots", () => {
  it("returns the first free windows after the lead time, skipping busy ones", async () => {
    const result = await getAvailableSlots(await depsAt(), {});
    expect(result.slots.map((s) => s.label)).toEqual([
      "Thu 12 Nov, 10:00–12:00",
      "Thu 12 Nov, 15:00–17:00",
      "Fri 13 Nov, 08:00–10:00",
      "Fri 13 Nov, 13:00–15:00",
      "Fri 13 Nov, 15:00–17:00",
      "Sat 14 Nov, 11:00–13:00",
    ]);
    expect(result.slots[0]).toMatchObject({ start: "2026-11-12T10:00:00+00:00", end: "2026-11-12T12:00:00+00:00" });
    expect(result.searched_from).toBe("2026-11-09");
    expect(result.searched_to).toBe("2026-11-15");
  });

  it("respects part of day, Saturdays and max_results", async () => {
    const deps = await depsAt();
    // Mon 16 morning and all of Tue 17 are booked, so the third morning is Wed 18.
    const mornings = await getAvailableSlots(deps, { part_of_day: "morning", include_saturdays: false, days: 14, max_results: 3 });
    expect(mornings.slots.map((s) => s.label)).toEqual([
      "Thu 12 Nov, 10:00–12:00",
      "Fri 13 Nov, 08:00–10:00",
      "Wed 18 Nov, 08:00–10:00",
    ]);
    const afternoons = await getAvailableSlots(deps, { part_of_day: "afternoon", max_results: 2 });
    expect(afternoons.slots.every((s) => Number(s.start.slice(11, 13)) >= 12)).toBe(true);
  });

  it("honours the minimum lead time", async () => {
    // Empty calendar, Thursday 07:00: the 08:00 and 10:00 windows are inside the 4-hour lead time.
    const deps = { ...(await depsAt(london("2026-11-12T07:00"))), calendar: { getBusy: async () => [] } };
    const result = await getAvailableSlots(deps, { days: 1 });
    expect(result.slots.map((s) => s.label)).toEqual(["Thu 12 Nov, 13:00–15:00", "Thu 12 Nov, 15:00–17:00"]);
  });

  it("searches from a given date and clips to the 14-day horizon", async () => {
    const result = await getAvailableSlots(await depsAt(), { from_date: "2026-11-20", days: 14 });
    expect(result.searched_from).toBe("2026-11-20");
    expect(result.searched_to).toBe("2026-11-23");
    expect(result.note).toContain("14-day booking horizon");
  });

  it("rejects a from_date beyond the horizon", async () => {
    await expect(getAvailableSlots(await depsAt(), { from_date: "2027-01-30" })).rejects.toBeInstanceOf(ToolInputError);
  });

  it("explains when nothing is free", async () => {
    // Tue 10 Nov is a full-day installation.
    const result = await getAvailableSlots(await depsAt(london("2026-11-10T06:00")), { days: 1 });
    expect(result.slots).toEqual([]);
    expect(result.note).toContain("No free windows");
  });
});
