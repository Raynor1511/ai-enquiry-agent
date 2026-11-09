import type { DateTime } from "luxon";

/** "HH:mm" pairs, local business time. */
export type WindowSpec = [string, string];

export interface AvailabilityRules {
  timezone: string;
  /** Longest look-ahead the tool will search, in days. */
  horizon_days: number;
  /** Earliest a new appointment can start, in hours from now. */
  min_lead_hours: number;
  /** Bank holidays and other closed days, "YYYY-MM-DD". */
  closed_dates: string[];
  appointment_windows: {
    weekday: WindowSpec[];
    saturday: WindowSpec[];
    sunday: WindowSpec[];
  };
}

export type TemplateBooking =
  | { business_day: number; start: string; end: string; title: string }
  | { saturday: number; start: string; end: string; title: string };

export interface CalendarTemplate extends AvailabilityRules {
  bookings: TemplateBooking[];
}

export interface BusyInterval {
  start: DateTime;
  end: DateTime;
}

/** Source of busy time: the seed template locally, Google Calendar free/busy in production. */
export interface CalendarProvider {
  getBusy(from: DateTime, to: DateTime): Promise<BusyInterval[]>;
}
