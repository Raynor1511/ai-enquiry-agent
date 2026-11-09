import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("defaults to local JSON data over stdio", () => {
    const config = loadConfig({}, []);
    expect(config).toMatchObject({ dataSource: "json", transport: "stdio", host: "127.0.0.1", port: 3333 });
    expect(config.seedDataDir.replace(/\\/g, "/")).toMatch(/seed\/data$/);
  });

  it("reads the transport from a flag", () => {
    expect(loadConfig({}, ["--transport", "http"]).transport).toBe("http");
    expect(loadConfig({}, ["--transport=http", "--port=4000"])).toMatchObject({ transport: "http", port: 4000 });
  });

  it("refuses to expose HTTP publicly without a token", () => {
    expect(() => loadConfig({ MCP_TRANSPORT: "http", HOST: "0.0.0.0" }, [])).toThrow(/MCP_AUTH_TOKEN/);
    expect(() => loadConfig({ MCP_TRANSPORT: "http", HOST: "0.0.0.0", MCP_AUTH_TOKEN: "x".repeat(32) }, [])).not.toThrow();
  });

  it("rejects short tokens, bad values and postgres without a URL", () => {
    expect(() => loadConfig({ MCP_AUTH_TOKEN: "short" }, [])).toThrow(/24 characters/);
    expect(() => loadConfig({ DATA_SOURCE: "mysql" }, [])).toThrow(/DATA_SOURCE/);
    expect(() => loadConfig({ DATA_SOURCE: "postgres" }, [])).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ PORT: "abc" }, [])).toThrow(/PORT/);
  });
});
