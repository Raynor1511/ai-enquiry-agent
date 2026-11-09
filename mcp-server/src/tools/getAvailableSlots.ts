import { z } from "zod";
import { candidateWindows, freeSlots, type Slot } from "../domain/availability.js";
import { ToolInputError, type ToolDeps } from "./deps.js";

export const getAvailableSlotsInput = {
  from_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .optional()
    .describe("First day to search (YYYY-MM-DD, UK time). Defaults to today."),
  days: z.number().int().min(1).max(14).optional().describe("How many days to search from from_date (default 7, max 14)."),
  part_of_day: z.enum(["morning", "afternoon", "any"]).optional().describe("Customer preference (default any)."),
  include_saturdays: z.boolean().optional().describe("Include Saturday morning windows (default true)."),
  max_results: z.number().int().min(1).max(20).optional().describe("Maximum slots to return (default 6)."),
};

const schema = z.object(getAvailableSlotsInput);
export type GetAvailableSlotsArgs = z.infer<typeof schema>;

export const getAvailableSlotsDescription = [
  "List free two-hour appointment arrival windows in the coming days (UK time).",
  "Offer the customer two or three of them. This does NOT book or hold anything: a booking is only made after a person approves the reply.",
  "Not for emergencies, which are attended outside the normal appointment calendar.",
].join(" ");

export interface GetAvailableSlotsResult {
  timezone: string;
  searched_from: string;
  searched_to: string;
  slots: Slot[];
  total_free_in_range: number;
  note: string;
}

export async function getAvailableSlots(
  deps: ToolDeps,
  args: GetAvailableSlotsArgs,
): Promise<GetAvailableSlotsResult> {
  const now = deps.now();
  const search = candidateWindows(
    deps.rules,
    {
      fromDate: args.from_date,
      days: args.days ?? 7,
      partOfDay: args.part_of_day ?? "any",
      includeSaturdays: args.include_saturdays ?? true,
      maxResults: args.max_results ?? 6,
    },
    now,
  );
  if (args.from_date && search.searchFrom >= search.searchTo) {
    throw new ToolInputError(
      `from_date is beyond the ${deps.rules.horizon_days}-day booking horizon. Search an earlier date, or say we'll confirm a date nearer the time.`,
    );
  }

  const busy = search.candidates.length
    ? await deps.calendar.getBusy(search.searchFrom, search.searchTo)
    : [];
  const { slots, totalFree } = freeSlots(search.candidates, busy, args.max_results ?? 6);

  const notes = [
    "Times are two-hour arrival windows, not exact appointment times.",
    "Nothing is booked until the reply is approved and the customer confirms.",
  ];
  if (search.clippedToHorizon) notes.push(`Search was limited to the ${deps.rules.horizon_days}-day booking horizon.`);
  if (slots.length === 0) notes.push("No free windows in this range: offer to call them, or search a later range.");

  return {
    timezone: deps.rules.timezone,
    searched_from: search.searchFrom.toISODate()!,
    searched_to: search.searchTo.minus({ days: 1 }).toISODate()!,
    slots,
    total_free_in_range: totalFree,
    note: notes.join(" "),
  };
}
