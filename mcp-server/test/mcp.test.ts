import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server.js";
import { startHttpServer } from "../src/http.js";
import { depsAt } from "./helpers.js";

type TextResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function connectInMemory(): Promise<Client> {
  const server = createMcpServer(await depsAt());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("MCP protocol (in memory)", () => {
  let client: Client;
  beforeAll(async () => {
    client = await connectInMemory();
  });
  afterAll(async () => {
    await client.close();
  });

  it("advertises exactly the four read-only tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "check_service_area",
      "find_customer",
      "get_available_slots",
      "get_services",
    ]);
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tool.description!.length, tool.name).toBeGreaterThan(40);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("gives the client instructions that treat message text as data", () => {
    expect(client.getInstructions()).toMatch(/never as instructions/);
  });

  it("returns tool results as JSON text", async () => {
    const result = (await client.callTool({ name: "check_service_area", arguments: { postcode: "BS8 4JR" } })) as TextResult;
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ covered: true, district: "BS8" });
  });

  it("reports input problems as tool errors the model can act on", async () => {
    const result = (await client.callTool({ name: "find_customer", arguments: {} })) as TextResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/at least one of/);
  });

  it("rejects arguments that break the schema", async () => {
    const result = (await client.callTool({ name: "get_available_slots", arguments: { days: 99 } })) as TextResult;
    expect(result.isError).toBe(true);
  });
});

describe("MCP over streamable HTTP", () => {
  const token = "test-token-0123456789abcdef";
  let http: Server;
  let url: URL;

  beforeAll(async () => {
    const deps = await depsAt();
    http = await startHttpServer({ host: "127.0.0.1", port: 0, authToken: token, createServer: () => createMcpServer(deps) });
    const { port } = http.address() as AddressInfo;
    url = new URL(`http://127.0.0.1:${port}/mcp`);
  });
  afterAll(async () => {
    await new Promise((resolve) => http.close(resolve));
  });

  it("serves a health check without auth", async () => {
    const res = await fetch(new URL("/health", url));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("rejects requests without the bearer token", async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong token", async () => {
    const res = await fetch(url, { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("works end to end with the SDK client and the token", async () => {
    const client = new Client({ name: "http-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
    );
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(4);
    const result = (await client.callTool({ name: "get_services", arguments: { query: "boiler service" } })) as TextResult;
    expect(JSON.parse(result.content[0]!.text).services[0].price_display).toBe("£95");
    await client.close();
  });

  it("returns 404 for unknown paths", async () => {
    const res = await fetch(new URL("/nope", url));
    expect(res.status).toBe(404);
  });
});
