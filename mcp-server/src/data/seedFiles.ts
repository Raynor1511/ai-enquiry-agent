import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Customer, District, Job, Policy, Service, Zone } from "./types.js";
import type { CalendarTemplate } from "../calendar/types.js";

export interface SeedData {
  services: Service[];
  policies: Policy[];
  customers: Customer[];
  jobs: Job[];
  districts: District[];
  calendar: CalendarTemplate;
}

interface ServiceAreasFile {
  zones: Array<{
    zone: Zone;
    travel_surcharge: number;
    response_target_minutes: number;
    districts: Record<string, string>;
  }>;
}

async function readJson<T>(dir: string, file: string): Promise<T> {
  const full = path.join(dir, file);
  try {
    return JSON.parse(await readFile(full, "utf8")) as T;
  } catch (err) {
    throw new Error(`Could not read seed file ${full}: ${(err as Error).message}`);
  }
}

/** Flatten service-areas.json into one row per district, the same shape as the database table. */
export function flattenServiceAreas(file: ServiceAreasFile): District[] {
  return file.zones.flatMap((z) =>
    Object.entries(z.districts).map(([district, area_name]) => ({
      district: district.toUpperCase(),
      zone: z.zone,
      area_name,
      travel_surcharge: z.travel_surcharge,
      response_target_minutes: z.response_target_minutes,
    })),
  );
}

export async function loadSeedData(dir: string): Promise<SeedData> {
  const [services, policies, customers, jobs, areas, calendar] = await Promise.all([
    readJson<Service[]>(dir, "services.json"),
    readJson<Policy[]>(dir, "policies.json"),
    readJson<Customer[]>(dir, "customers.json"),
    readJson<Job[]>(dir, "jobs.json"),
    readJson<ServiceAreasFile>(dir, "service-areas.json"),
    readJson<CalendarTemplate>(dir, "calendar.json"),
  ]);
  return { services, policies, customers, jobs, districts: flattenServiceAreas(areas), calendar };
}

/** Only the calendar rules/template, for when business data comes from Postgres. */
export async function loadCalendarTemplate(dir: string): Promise<CalendarTemplate> {
  return readJson<CalendarTemplate>(dir, "calendar.json");
}
