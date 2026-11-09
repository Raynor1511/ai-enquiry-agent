import pg from "pg";
import type { BusinessDataStore, Customer, District, Job, Policy, Service } from "./types.js";

export interface PgStoreOptions {
  connectionString: string;
  /** "require" = TLS with certificate checks, "no-verify" = TLS without checks, "disable"/undefined = as the URL says. */
  ssl?: "require" | "no-verify" | "disable";
  maxConnections?: number;
}

// numeric columns arrive as strings by default; prices are small, so plain JS numbers are safe.
const NUMERIC_OID = 1700;
const types = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (oid === NUMERIC_OID) return (v: string) => (v === null ? null : Number(v));
    return pg.types.getTypeParser(oid, format as "text");
  },
} as pg.CustomTypesConfig;

const CUSTOMER_COLUMNS = `id, first_name, last_name, company_name, customer_type, email, phone,
  address_line1, town, postcode, to_char(customer_since, 'YYYY-MM-DD') as customer_since, notes`;

/**
 * Postgres/Supabase store. Every query runs inside a READ ONLY transaction, on top of the
 * database role itself only having SELECT rights (seed/sql/003_roles.sql): two independent
 * guarantees that nothing the agent does through this server can change data.
 */
export class PgDataStore implements BusinessDataStore {
  private readonly pool: pg.Pool;

  constructor(options: PgStoreOptions) {
    const ssl =
      options.ssl === "require" ? { rejectUnauthorized: true } :
      options.ssl === "no-verify" ? { rejectUnauthorized: false } :
      undefined;
    this.pool = new pg.Pool({
      connectionString: options.connectionString,
      ssl,
      types,
      max: options.maxConnections ?? 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: "harbourline-mcp",
    });
  }

  private async readOnly<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      const result = await client.query<T>(sql, params);
      await client.query("COMMIT");
      return result.rows;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  findCustomersByEmail(email: string): Promise<Customer[]> {
    return this.readOnly<Customer>(
      `select ${CUSTOMER_COLUMNS} from customers where lower(trim(email)) = lower(trim($1)) order by id limit 5`,
      [email],
    );
  }

  findCustomersByPhone(phone: string): Promise<Customer[]> {
    return this.readOnly<Customer>(
      `select ${CUSTOMER_COLUMNS} from customers where normalise_uk_phone(phone) = $1 order by id limit 5`,
      [phone],
    );
  }

  findCustomersByName(key: string, limit: number): Promise<Customer[]> {
    return this.readOnly<Customer>(
      `select ${CUSTOMER_COLUMNS} from customers
        where name_key(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) = $1
           or (company_name is not null and name_key(company_name) = $1)
        order by id limit $2`,
      [key, limit],
    );
  }

  getJobsForCustomer(customerId: string, limit: number): Promise<Job[]> {
    return this.readOnly<Job>(
      `select id, customer_id, service_id, status, to_char(job_date, 'YYYY-MM-DD') as job_date,
              amount, reference, engineer, notes
         from jobs where customer_id = $1
        order by job_date desc nulls last, id desc limit $2`,
      [customerId, limit],
    );
  }

  async countJobsForCustomer(customerId: string): Promise<number> {
    const rows = await this.readOnly<{ n: number }>(
      `select count(*)::int as n from jobs where customer_id = $1`,
      [customerId],
    );
    return rows[0]?.n ?? 0;
  }

  listServices(): Promise<Service[]> {
    return this.readOnly<Service>(
      `select id, name, category, description, price_basis, price_min, price_max, price_note,
              typical_duration_minutes, requires_survey, keywords
         from services where active order by category, id`,
    );
  }

  listPolicies(): Promise<Policy[]> {
    return this.readOnly<Policy>(
      `select id, title, category, applies_to, body from policies where active order by id`,
    );
  }

  async getDistrict(outwardCode: string): Promise<District | null> {
    const rows = await this.readOnly<District>(
      `select district, zone, area_name, travel_surcharge, response_target_minutes
         from service_area_districts where district = upper($1)`,
      [outwardCode],
    );
    return rows[0] ?? null;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
