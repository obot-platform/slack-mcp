/**
 * Standalone Mode OFF (default, stateless behavior).
 *
 * No SLACK_APP_TOKEN is set, so:
 * - isStandaloneModeActive() returns false
 * - tools/list does NOT include wait_for_event
 * - GET /mcp returns 405 (preserved upstream behavior)
 * - calling wait_for_event returns a tool-not-found error
 * - the existing 22 tools are still present (regression check)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

const MCP_HEADERS = {
  // The StreamableHTTPServerTransport requires these Accept headers;
  // without them it returns 406 Not Acceptable.
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
};

/** Parse the JSON-RPC body from a SSE response (event: message\ndata: <json>\n\n) */
const parseSSEResponse = (text: string): any => {
  const dataLines: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      dataLines.push(line.slice("data: ".length));
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  return JSON.parse(dataLines.join("\n"));
};

const loadModule = async () => {
  return import("../index.js");
};

describe("Standalone Mode OFF (default, stateless)", () => {
  let app: any;
  let isStandaloneModeActive: () => boolean;

  beforeAll(async () => {
    delete process.env.SLACK_APP_TOKEN;
    const mod = await loadModule();
    app = mod.app;
    isStandaloneModeActive = mod.isStandaloneModeActive;
  });
  afterAll(() => {
    delete process.env.SLACK_APP_TOKEN;
  });

  it("isStandaloneModeActive() returns false", () => {
    expect(isStandaloneModeActive()).toBe(false);
  });

  it("GET /mcp returns 405 (preserved upstream behavior)", async () => {
    const res = await request(app)
      .get("/mcp")
      .set("Accept", "text/event-stream");
    expect(res.status).toBe(405);
  });

  it("POST /mcp tools/list does NOT include wait_for_event", async () => {
    const res = await request(app)
      .post("/mcp")
      .set(MCP_HEADERS)
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      });
    expect(res.status).toBe(200);
    const body = parseSSEResponse(res.text);
    const tools = body?.result?.tools ?? [];
    const names = tools.map((t: any) => t.name);
    expect(names).not.toContain("wait_for_event");
  });

  it("POST /mcp tools/list still includes the existing 22 tools", async () => {
    const res = await request(app)
      .post("/mcp")
      .set(MCP_HEADERS)
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      });
    expect(res.status).toBe(200);
    const body = parseSSEResponse(res.text);
    const tools = body?.result?.tools ?? [];
    const names = tools.map((t: any) => t.name);
    // Spot-check a few existing tools to make sure we didn't break anything.
    expect(names).toContain("list_channels");
    expect(names).toContain("send_message");
    expect(names).toContain("get_thread_history");
  });

  it("POST /mcp tools/call with wait_for_event returns a tool-not-found error", async () => {
    const res = await request(app)
      .post("/mcp")
      .set(MCP_HEADERS)
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "wait_for_event",
          arguments: { timeoutMs: 200 },
        },
      });
    const body = parseSSEResponse(res.text);
    // The MCP SDK returns a result with isError=true and an error message
    // in content[0].text (not a top-level JSON-RPC error).
    expect(body?.result?.isError).toBe(true);
    const text = body?.result?.content?.[0]?.text ?? "";
    expect(text.toLowerCase()).toContain("wait_for_event");
    expect(text.toLowerCase()).toContain("not found");
  });
});
