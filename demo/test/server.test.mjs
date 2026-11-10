// The demo service end to end over HTTP, with n8n and the database replaced by fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createApp, n8nClient } from "../server.mjs";
import { hashToken, newToken } from "../lib/validate.mjs";

const HOST = "enquiries.example.org";
const ORIGIN = `https://${HOST}`;

async function withServer(deps, fn) {
  const logs = [];
  const app = createApp({ publicHost: HOST, log: (m) => logs.push(m), ...deps });
  const server = createServer(app).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, logs);
  } finally {
    server.close();
  }
}
const post = (base, path, body, headers = {}) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

const submission = { name: "Dana", email: "dana@visitor-mail.org", service_needed: "Boiler or heating", message: "Boiler keeps banging at night." };

test("pages and assets are served with strict security headers; anything else is a 404", async () => {
  await withServer({ n8n: async () => ({}), view: async () => null }, async (base) => {
    for (const p of ["/demo", "/demo/", "/demo/confirm", "/demo/e"]) {
      const res = await fetch(`${base}${p}`);
      assert.equal(res.status, 200, p);
      assert.match(res.headers.get("content-type"), /text\/html/);
      const csp = res.headers.get("content-security-policy");
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /script-src 'self'(;|$)/);
      assert.match(csp, /frame-src https:\/\/calendar\.google\.com/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.equal(res.headers.get("referrer-policy"), "no-referrer");
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      const html = await res.text();
      assert.ok(!/<script>|style="|onclick=|javascript:/i.test(html), `${p}: no inline script or style`);
    }
    assert.equal((await fetch(`${base}/demo/assets/live.js`)).status, 200);
    for (const p of ["/demo/assets/../server.mjs", "/demo/assets/server.mjs", "/demo/assets/%2e%2e/server.mjs", "/demo/x", "/", "/webhook/harbourline-demo-start"]) {
      assert.equal((await fetch(`${base}${p}`)).status, 404, p);
    }
  });
});

test("start: valid form -> a fresh token to n8n, never a token back to the browser", async () => {
  const calls = [];
  const n8n = async (hook, body) => { calls.push([hook, body]); return { status: 200, json: { ok: true, emailed: true } }; };
  await withServer({ n8n, view: async () => null }, async (base) => {
    const res = await post(base, "/demo/api/start", submission);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    const [hook, body] = calls[0];
    assert.equal(hook, "harbourline-demo-start");
    assert.equal(hashToken(body.token), body.token_hash);
    assert.equal(body.email, "dana@visitor-mail.org");
    assert.equal(body.allow_reserved, undefined, "the public service never allows test addresses");
  });
});

test("start: n8n's limits and failures become friendly messages", async () => {
  let reply;
  const n8n = async () => reply;
  await withServer({ n8n, view: async () => null }, async (base) => {
    reply = { status: 429, json: { ok: false, error: "email_limit" } };
    let res = await post(base, "/demo/api/start", submission);
    assert.equal(res.status, 429);
    assert.match((await res.json()).errors.form, /several demo links today/);
    reply = { status: 200, json: { ok: false, emailed: false, error: "email_failed" } };
    res = await post(base, "/demo/api/start", submission);
    assert.equal(res.status, 502);
    res = await post(base, "/demo/api/start", { ...submission, email: "x@example.com" });
    assert.equal(res.status, 400);
    assert.ok((await res.json()).errors.email);
  });
});

test("the API refuses other sites, other content types, big bodies and bad JSON", async () => {
  let called = 0;
  const n8n = async () => { called++; return { status: 200, json: { ok: true } }; };
  await withServer({ n8n, view: async () => null }, async (base) => {
    assert.equal((await post(base, "/demo/api/start", submission, { Origin: "https://evil.example" })).status, 403);
    assert.equal((await fetch(`${base}/demo/api/start`, { method: "POST", body: JSON.stringify(submission), headers: { "Content-Type": "application/json" } })).status, 403, "no Origin");
    assert.equal((await post(base, "/demo/api/start", "name=x", { "Content-Type": "application/x-www-form-urlencoded" })).status, 415);
    assert.equal((await post(base, "/demo/api/start", "{not json")).status, 400);
    assert.equal((await post(base, "/demo/api/start", { ...submission, message: "x".repeat(20_000) })).status, 413);
    assert.equal((await post(base, "/demo/api/nope", {})).status, 404);
    assert.equal((await post(base, "/demo/api/__proto__", {})).status, 404);
    assert.equal((await post(base, "/demo/api/constructor", {})).status, 404);
    assert.equal((await fetch(`${base}/demo/api/state`)).status, 404, "GET");
    // A filled-in honeypot pretends to succeed and sends nothing.
    const res = await post(base, "/demo/api/start", { ...submission, website: "x" });
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(called, 0);
  });
});

test("confirm, state and decide use only the token's hash, and never log the token", async () => {
  const { token, token_hash } = newToken();
  const seen = [];
  const n8n = async (hook, body) => {
    seen.push([hook, body]);
    if (hook === "harbourline-demo-confirm") return { status: 200, json: { ok: true, status: "confirmed" } };
    return { status: 200, json: { ok: true, decision: "edited", status: "sent", final_body: "secret" } };
  };
  const view = async (h) => (h === token_hash ? { session: { status: "confirmed", confirmed_at: new Date().toISOString(), payload: { message: "m" } }, retention_days: 7 } : null);
  await withServer({ n8n, view }, async (base, logs) => {
    let res = await post(base, "/demo/api/confirm", { t: token });
    assert.deepEqual(await res.json(), { ok: true, status: "confirmed" });
    res = await post(base, "/demo/api/state", { t: token });
    assert.equal(res.status, 200);
    const s = await res.json();
    assert.equal(s.phase, "starting");
    assert.equal((await post(base, "/demo/api/state", { t: newToken().token })).status, 404);
    assert.equal((await post(base, "/demo/api/state", { t: "nope" })).status, 404);
    res = await post(base, "/demo/api/decide", { t: token, kind: "edit_submit", subject: "S", body: "B" });
    assert.deepEqual(await res.json(), { ok: true, status: "sent" }, "only ok and status reach the browser");
    assert.equal((await post(base, "/demo/api/decide", { t: token, kind: "edit_submit", body: "" })).status, 400);
    for (const [, body] of seen) {
      assert.equal(body.token_hash, token_hash);
      assert.ok(!JSON.stringify(body).includes(token), "n8n never sees the token after start");
    }
    assert.deepEqual(seen.at(-1)[1], { token_hash, kind: "edit_submit", subject: "S", body: "B" });
    assert.ok(logs.length > 0);
    assert.ok(!logs.join("\n").includes(token), "no token in the logs");
  });
});

test("an unreachable n8n or database is a 502, not a crash", async () => {
  const n8n = async () => { throw new Error("connect ECONNREFUSED"); };
  const view = async () => { throw new Error("db down"); };
  await withServer({ n8n, view }, async (base) => {
    assert.equal((await post(base, "/demo/api/start", submission)).status, 502);
    assert.equal((await post(base, "/demo/api/state", { t: newToken().token })).status, 502);
    assert.equal((await fetch(`${base}/demo/healthz`)).status, 200);
  });
});

test("the n8n client sends the shared key and JSON", async () => {
  let got;
  const server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { got = { url: req.url, key: req.headers["x-harbourline-demo-key"], body: JSON.parse(b) }; res.writeHead(409, { "Content-Type": "application/json" }); res.end('{"ok":false}'); });
  }).listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const call = n8nClient(`http://127.0.0.1:${server.address().port}`, "k".repeat(64));
    assert.deepEqual(await call("harbourline-demo-decide", { a: 1 }, 5000), { status: 409, json: { ok: false } });
    assert.deepEqual(got, { url: "/webhook/harbourline-demo-decide", key: "k".repeat(64), body: { a: 1 } });
  } finally {
    server.close();
  }
});
