import { DateTime } from "luxon";
import type { BusyInterval, CalendarProvider } from "./types.js";
import type { ServiceAccountTokenSource } from "./googleAuth.js";

const API = "https://www.googleapis.com/calendar/v3";

/**
 * Busy time from Google Calendar's free/busy API. Only start and end times are fetched,
 * never event titles or attendees, so no customer details pass through the MCP server.
 */
export class GoogleCalendarProvider implements CalendarProvider {
  constructor(
    private readonly calendarId: string,
    private readonly tokens: ServiceAccountTokenSource,
    private readonly timezone: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getBusy(from: DateTime, to: DateTime): Promise<BusyInterval[]> {
    const res = await this.fetchImpl(`${API}/freeBusy`, {
      method: "POST",
      headers: { authorization: `Bearer ${await this.tokens.token()}`, "content-type": "application/json" },
      body: JSON.stringify({
        timeMin: from.toUTC().toISO(),
        timeMax: to.toUTC().toISO(),
        timeZone: this.timezone,
        items: [{ id: this.calendarId }],
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: Array<{ reason: string }> }>;
      error?: { message?: string };
    };
    if (!res.ok) throw new Error(`Google free/busy request failed (${res.status}): ${body.error?.message ?? ""}`);

    const entry = body.calendars?.[this.calendarId];
    if (!entry) throw new Error("Google free/busy response did not include the calendar");
    if (entry.errors?.length) {
      // e.g. "notFound" when the calendar isn't shared with the service account.
      throw new Error(`Google Calendar error: ${entry.errors.map((e) => e.reason).join(", ")}`);
    }
    return (entry.busy ?? []).map((b) => ({
      start: DateTime.fromISO(b.start, { zone: this.timezone }),
      end: DateTime.fromISO(b.end, { zone: this.timezone }),
    }));
  }
}
