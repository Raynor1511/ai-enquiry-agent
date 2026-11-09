import { describe, expect, it } from "vitest";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CALENDAR_READONLY,
  loadServiceAccountKey,
  ServiceAccountTokenSource,
  type ServiceAccountKey,
} from "../src/calendar/googleAuth.js";
import { GoogleCalendarProvider } from "../src/calendar/googleCalendar.js";
import { getAvailableSlots } from "../src/tools/getAvailableSlots.js";
import { depsAt, MONDAY_10AM } from "./helpers.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY: ServiceAccountKey = {
  type: "service_account",
  client_email: "reader@demo.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  token_uri: "https://oauth2.example/token",
};
const CAL = "abc123@group.calendar.google.com";

interface Call {
  url: string;
  init: RequestInit;
}

/** A fake fetch that serves the token endpoint and free/busy, recording every call. */
function fakeGoogle(busy: Array<{ start: string; end: string }> = [], calendarErrors?: Array<{ reason: string }>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url === KEY.token_uri) {
      return new Response(JSON.stringify({ access_token: `tok-${calls.length}`, expires_in: 3600 }), { status: 200 });
    }
    if (url.endsWith("/freeBusy")) {
      return new Response(JSON.stringify({ calendars: { [CAL]: calendarErrors ? { errors: calendarErrors } : { busy } } }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("ServiceAccountTokenSource", () => {
  it("signs a valid RS256 JWT with only the requested scope", async () => {
    const { impl, calls } = fakeGoogle();
    await new ServiceAccountTokenSource(KEY, CALENDAR_READONLY, impl).token();

    const form = new URLSearchParams(calls[0]!.init.body as string);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [header, claims, signature] = form.get("assertion")!.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = JSON.parse(Buffer.from(claims!, "base64url").toString());
    expect(payload).toMatchObject({ iss: KEY.client_email, aud: KEY.token_uri, scope: CALENDAR_READONLY });
    expect(payload.exp - payload.iat).toBe(3600);
    const valid = createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature!, "base64url"));
    expect(valid).toBe(true);
  });

  it("caches the token until shortly before expiry", async () => {
    const { impl, calls } = fakeGoogle();
    const source = new ServiceAccountTokenSource(KEY, CALENDAR_READONLY, impl);
    expect(await source.token()).toBe(await source.token());
    expect(calls).toHaveLength(1);
  });

  it("reports token errors from Google", async () => {
    const impl = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "Invalid JWT Signature." }), { status: 400 })) as unknown as typeof fetch;
    await expect(new ServiceAccountTokenSource(KEY, CALENDAR_READONLY, impl).token()).rejects.toThrow(/invalid_grant/);
  });
});

describe("loadServiceAccountKey", () => {
  it("rejects files that are not service account keys", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sa-"));
    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ type: "authorized_user" }));
    await expect(loadServiceAccountKey(bad)).rejects.toThrow(/not a Google service account/);
    await expect(loadServiceAccountKey(path.join(dir, "missing.json"))).rejects.toThrow(/Could not read/);
  });
});

describe("GoogleCalendarProvider", () => {
  it("asks free/busy for just this calendar and maps busy blocks to local time", async () => {
    const { impl, calls } = fakeGoogle([{ start: "2026-11-12T08:00:00Z", end: "2026-11-12T10:00:00Z" }]);
    const provider = new GoogleCalendarProvider(CAL, new ServiceAccountTokenSource(KEY, CALENDAR_READONLY, impl), "Europe/London", impl);
    const busy = await provider.getBusy(MONDAY_10AM, MONDAY_10AM.plus({ days: 7 }));

    const request = calls.find((c) => c.url.endsWith("/freeBusy"))!;
    expect((request.init.headers as Record<string, string>).authorization).toMatch(/^Bearer tok-/);
    expect(JSON.parse(request.init.body as string)).toMatchObject({ items: [{ id: CAL }], timeZone: "Europe/London" });
    expect(busy).toHaveLength(1);
    expect(busy[0]!.start.toISO()).toBe("2026-11-12T08:00:00.000+00:00");
  });

  it("turns a calendar error (e.g. not shared) into a clear failure", async () => {
    const { impl } = fakeGoogle([], [{ reason: "notFound" }]);
    const provider = new GoogleCalendarProvider(CAL, new ServiceAccountTokenSource(KEY, CALENDAR_READONLY, impl), "Europe/London", impl);
    await expect(provider.getBusy(MONDAY_10AM, MONDAY_10AM.plus({ days: 1 }))).rejects.toThrow(/notFound/);
  });

  it("drives get_available_slots like the seed calendar does", async () => {
    // Busy all of Thursday 12 Nov: the first free window becomes Friday 08:00.
    const { impl } = fakeGoogle([
      { start: "2026-11-09T00:00:00Z", end: "2026-11-12T23:59:00Z" },
    ]);
    const deps = {
      ...(await depsAt()),
      calendar: new GoogleCalendarProvider(CAL, new ServiceAccountTokenSource(KEY, CALENDAR_READONLY, impl), "Europe/London", impl),
    };
    const result = await getAvailableSlots(deps, { max_results: 2 });
    expect(result.slots.map((s) => s.label)).toEqual(["Fri 13 Nov, 08:00–10:00", "Fri 13 Nov, 10:00–12:00"]);
  });
});

describe("config for Google Calendar", () => {
  it("requires the calendar id and key file", async () => {
    const { loadConfig } = await import("../src/config.js");
    expect(() => loadConfig({ CALENDAR_SOURCE: "google" }, [])).toThrow(/GOOGLE_CALENDAR_ID/);
    expect(loadConfig({ CALENDAR_SOURCE: "google", GOOGLE_CALENDAR_ID: CAL, GOOGLE_SERVICE_ACCOUNT_KEY_FILE: "/k.json" }, []).calendarSource).toBe("google");
  });
});
