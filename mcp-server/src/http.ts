import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { log } from "./logger.js";

export interface HttpOptions {
  host: string;
  port: number;
  authToken?: string;
  /** A fresh server per request keeps the HTTP mode stateless (no sessions to leak or expire). */
  createServer: () => McpServer;
}

const MAX_BODY_BYTES = 1_000_000;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function jsonRpcError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null }, headers);
}

/** Constant-time token comparison (hash first so lengths always match). */
function tokenMatches(header: string | undefined, expected: string): boolean {
  const presented = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return presented.length > 0 && timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}

/**
 * Streamable HTTP endpoint at POST /mcp (what n8n's MCP Client Tool node connects to),
 * plus GET /health for container health checks.
 */
export function startHttpServer(options: HttpOptions): Promise<Server> {
  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/health" && req.method === "GET") {
      return sendJson(res, 200, { status: "ok" });
    }
    if (url.pathname !== "/mcp") {
      return sendJson(res, 404, { error: "Not found" });
    }
    if (options.authToken && !tokenMatches(req.headers.authorization, options.authToken)) {
      log("warn", "http_unauthorised", { method: req.method, ip: req.socket.remoteAddress });
      return jsonRpcError(res, 401, "Unauthorised", { "www-authenticate": "Bearer" });
    }
    if (req.method !== "POST") {
      // Stateless mode: no server-initiated streams (GET) or sessions to end (DELETE).
      return jsonRpcError(res, 405, "Method not allowed", { allow: "POST" });
    }

    let body: unknown;
    try {
      body = await readBody(req);
    } catch (err) {
      return jsonRpcError(res, (err as { status?: number }).status ?? 400, (err as Error).message);
    }

    const server = options.createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log("error", "http_request_failed", { error: (err as Error).message });
      if (!res.headersSent) jsonRpcError(res, 500, "Internal server error");
    }
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host, () => {
      httpServer.off("error", reject);
      resolve(httpServer);
    });
  });
}
