import { normaliseUkPhone } from "../domain/phone.js";
import { nameKey } from "../domain/text.js";
import type { BusinessDataStore, Customer, District, Job, Policy, Service } from "./types.js";
import type { SeedData } from "./seedFiles.js";

/** In-memory store over the seed JSON files. Used for local development, Claude Desktop demos and tests. */
export class JsonDataStore implements BusinessDataStore {
  constructor(private readonly data: SeedData) {}

  async findCustomersByEmail(email: string): Promise<Customer[]> {
    const wanted = email.trim().toLowerCase();
    return this.data.customers.filter((c) => c.email?.trim().toLowerCase() === wanted);
  }

  async findCustomersByPhone(phone: string): Promise<Customer[]> {
    return this.data.customers.filter((c) => c.phone != null && normaliseUkPhone(c.phone) === phone);
  }

  async findCustomersByName(key: string, limit: number): Promise<Customer[]> {
    return this.data.customers
      .filter(
        (c) =>
          nameKey(`${c.first_name ?? ""} ${c.last_name ?? ""}`) === key ||
          (c.company_name != null && nameKey(c.company_name) === key),
      )
      .slice(0, limit);
  }

  async getJobsForCustomer(customerId: string, limit: number): Promise<Job[]> {
    return this.data.jobs
      .filter((j) => j.customer_id === customerId)
      .sort((a, b) => (b.job_date ?? "").localeCompare(a.job_date ?? "") || b.id.localeCompare(a.id))
      .slice(0, limit);
  }

  async countJobsForCustomer(customerId: string): Promise<number> {
    return this.data.jobs.filter((j) => j.customer_id === customerId).length;
  }

  async listServices(): Promise<Service[]> {
    return this.data.services;
  }

  async listPolicies(): Promise<Policy[]> {
    return this.data.policies;
  }

  async getDistrict(outwardCode: string): Promise<District | null> {
    const wanted = outwardCode.toUpperCase();
    return this.data.districts.find((d) => d.district === wanted) ?? null;
  }

  async close(): Promise<void> {}
}
