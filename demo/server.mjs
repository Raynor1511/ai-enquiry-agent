#!/usr/bin/env node
// The live demo page (docs/demo.md): https://<PUBLIC_HOST>/demo
//
//   visitor -> Caddy -> gate (rate limits) -> this service -> n8n's Demo webhooks (private network)
//                                                          -> Postgres as demo_web (demo_view() only)
//
// A visitor fills in the form, gets a confirm link by email, presses "Start my demo", and watches their
// enquiry go through the real pipeline; then approves, edits or rejects the draft, as the business would
// in Slack. Private links carry their token in the URL fragment, which browsers never send to servers,
// so tokens never reach a log; the API takes them in POST bodies. No framework: node:http and pg.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkDecision, checkSubmission, hashToken, newToken } from "./lib/validate.mjs";
import { shapeState } from "./lib/view.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 16 * 1024;

const PAGES = { "/demo": "index.html", "/demo/": "index.html", "/demo/confirm": "confirm.html", "/demo/e": "live.html" };
const ASSETS = {
  "style.css": "text/css; charset=utf-8",
  "form.js": "text/javascript; charset=utf-8",
  "confirm.js": "text/javascript; charset=utf-8",
  "live.js": "text/javascript; charset=utf-8",
  "icon.svg": "image/svg+xml",
};

export function securityHeaders() {
  return {
    "Content-Security-Policy": [
      "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "connect-src 'self'",
      "frame-src https://calendar.google.com", "form-action 'self'", "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'",
    ].join("; "),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  };
}

/** Friendly words for n8n's refusals of a new submission. */
const START_ERRORS = {
  email_limit: "This address has been sent several demo links today. Please use one of those, or try again tomorrow.",
  daily_limit: "The demo has had a lot of visitors today and has reached its daily limit. Please try again tomorrow.",
  email_failed: "We couldn't send the confirmation email just now. Please try again in a few minutes.",
};

/**
 * The request handler. Dependencies are passed in so tests can run it without n8n or a database:
 *   n8n(path, body, timeoutMs) -> { status, json }    view(tokenHash) -> demo_view() result or null
 */
export function createApp({ n8n, view, publicHost, calendarUrl = null, log = () => {}, files = loadFiles(), origin = `https://${publicHost}` }) {
  const send = (res, status, body, type = "application/json; charset=utf-8", extra = {}) => {
    res.writeHead(status, { ...securityHeaders(), "Content-Type": type, "Cache-Control": "no-store", ...extra });
    res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
  };

  const readJson = (req) =>
    new Promise((resolve, reject) => {
      const tooLarge = () => Object.assign(new Error("too large"), { status: 413 });
      if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) {
        req.resume(); // discard it unread
        return reject(tooLarge());
      }
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size <= MAX_BODY) return chunks.push(c);
        // Stop keeping it, let the rest drain, and answer 413.
        req.removeAllListeners("data");
        req.removeAllListeners("end");
        req.resume();
        reject(tooLarge());
      });
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
        } catch {
          reject(Object.assign(new Error("bad json"), { status: 400 }));
        }
      });
      req.on("error", reject);
    });

  const api = {
    async start(body) {
      const c = checkSubmission(body);
      if (c.bot) return [200, { ok: true }]; // pretend, so bots learn nothing
      if (!c.ok) return [400, { ok: false, errors: c.errors }];
      const { token, token_hash } = newToken();
      const r = await n8n("harbourline-demo-start", { token, token_hash, ...c.value }, 30_000);
      if (r.status === 200 && r.json?.ok) return [200, { ok: true }];
      if (r.status === 429) return [429, { ok: false, errors: { form: START_ERRORS[r.json?.error] ?? START_ERRORS.daily_limit } }];
      if (r.status === 400) return [400, { ok: false, errors: { form: "Please check the form and try again." } }];
      return [502, { ok: false, errors: { form: START_ERRORS.email_failed } }];
    },
    async confirm(body) {
      const hash = hashToken(body?.t);
      if (!hash) return [400, { ok: false, status: "unknown" }];
      const r = await n8n("harbourline-demo-confirm", { token_hash: hash }, 30_000);
      if (r.status !== 200 || !r.json) return [502, { ok: false, status: "error" }];
      return [200, { ok: Boolean(r.json.ok), status: String(r.json.status ?? "error") }];
    },
    async state(body) {
      const hash = hashToken(body?.t);
      if (!hash) return [404, { found: false }];
      const shaped = shapeState(await view(hash), { calendarUrl });
      return [shaped.found ? 200 : 404, shaped];
    },
    async decide(body) {
      const hash = hashToken(body?.t);
      if (!hash) return [404, { ok: false, status: "unknown" }];
      const c = checkDecision(body);
      if (!c.ok) return [400, { ok: false, error: c.error }];
      const r = await n8n("harbourline-demo-decide", { token_hash: hash, ...c.value }, 120_000);
      if ((r.status === 200 || r.status === 409) && r.json) return [r.status, { ok: Boolean(r.json.ok), status: String(r.json.status ?? "") }];
      return [502, { ok: false, status: "error" }];
    },
  };

  return async function handle(req, res) {
    const started = Date.now();
    const url = new URL(req.url, origin);
    const p = url.pathname;
    let status = 500;
    try {
      if (req.method === "GET" || req.method === "HEAD") {
        if (p === "/demo/healthz") return send(res, (status = 200), { ok: true });
        if (PAGES[p]) return send(res, (status = 200), files.pages[PAGES[p]], "text/html; charset=utf-8");
        const asset = p.startsWith("/demo/assets/") ? p.slice("/demo/assets/".length) : null;
        if (asset && ASSETS[asset]) {
          return send(res, (status = 200), files.assets[asset], ASSETS[asset], { "Cache-Control": "no-cache" }); // small files; never stale after a deploy
        }
        return send(res, (status = 404), files.pages["404.html"], "text/html; charset=utf-8");
      }
      const action = p.startsWith("/demo/api/") ? p.slice("/demo/api/".length) : null;
      if (req.method !== "POST" || !action || !Object.hasOwn(api, action)) return send(res, (status = 404), { ok: false });
      // Only this site's own pages may call the API (a browser always sends Origin on a POST).
      if (req.headers.origin !== origin) return send(res, (status = 403), { ok: false });
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, (status = 415), { ok: false });
      const body = await readJson(req);
      const [code, payload] = await api[action](body);
      return send(res, (status = code), payload);
    } catch (err) {
      status = err.status ?? 502;
      if (!res.headersSent) send(res, status, { ok: false, status: "error" });
      if (!err.status) log(`error on ${req.method} ${p}: ${err.message}`);
    } finally {
      log(`${req.method} ${p} ${status} ${Date.now() - started}ms`);
    }
  };
}

export function loadFiles(dir = path.join(here, "public")) {
  const pages = Object.fromEntries(["index.html", "confirm.html", "live.html", "404.html"].map((f) => [f, readFileSync(path.join(dir, f))]));
  const assets = Object.fromEntries(Object.keys(ASSETS).map((f) => [f, readFileSync(path.join(dir, f))]));
  return { pages, assets };
}

/** n8n's Demo webhooks, on the private network, with the shared header key. */
export function n8nClient(baseUrl, key) {
  return async (hook, body, timeoutMs) => {
    const res = await fetch(`${baseUrl}/webhook/${hook}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Harbourline-Demo-Key": key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {}
    return { status: res.status, json };
  };
}

function requireEnv(name, test = (v) => Boolean(v)) {
  const v = process.env[name] ?? "";
  if (!test(v)) {
    console.error(`demo: ${name} is missing or invalid`);
    process.exit(1);
  }
  return v;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { default: pg } = await import("pg");
  const publicHost = requireEnv("PUBLIC_HOST", (v) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v));
  const key = requireEnv("DEMO_N8N_KEY", (v) => /^[0-9a-f]{64}$/.test(v));
  const dbUrl = requireEnv("DEMO_DB_URL", (v) => /^postgres(ql)?:\/\//.test(v));
  const n8nUrl = requireEnv("N8N_INTERNAL_URL", (v) => /^https?:\/\//.test(v));
  const calendar = process.env.DEMO_CALENDAR_EMBED_URL ?? "";
  const calendarUrl = /^https:\/\/calendar\.google\.com\/calendar\/embed\?/.test(calendar) ? calendar : null;
  if (calendar && !calendarUrl) console.error("demo: DEMO_CALENDAR_EMBED_URL is not a Google Calendar embed address; the page shows no calendar");

  const pool = new pg.Pool({ connectionString: dbUrl, max: 3, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
  pool.on("error", (err) => console.error(`demo: database pool error: ${err.message}`));
  const view = async (hash) => (await pool.query("select demo_view($1) as v", [hash])).rows[0]?.v ?? null;
  const app = createApp({ n8n: n8nClient(n8nUrl, key), view, publicHost, calendarUrl, log: (m) => console.log(m) });
  const port = Number(process.env.PORT || 8080);
  const server = createServer(app);
  server.requestTimeout = 150_000;
  server.headersTimeout = 20_000;
  server.listen(port, "0.0.0.0", () => console.log(`demo: listening on :${port} for https://${publicHost}/demo${calendarUrl ? " (with calendar)" : ""}`));
  const stop = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
