/**
 * Standalone Mode ON (opt-in).
 *
 * SLACK_APP_TOKEN is set (to a dummy value); @slack/socket-mode is mocked
 * so we don't actually try to connect to Slack. The tests verify:
 * - isStandaloneModeActive() returns true
 * - tools/list DOES include wait_for_event
 * - GET /mcp returns 200 with text/event-stream
 * - wait_for_event round-trips: enqueue an event, then call wait_for_event,
 *   verify the event is returned. Also verify filters and no-double-delivery.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";

// Mock @slack/socket-mode BEFORE importing index.js. vi.mock is hoisted.
vi.mock("@slack/socket-mode", () => {
  return {
    SocketModeClient: class MockSocketModeClient {
      on = vi.fn();
      start = vi.fn(async () => ({}));
      disconnect = vi.fn(async () => {});
    },
  };
});

const MCP_HEADERS = {
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

const callMCP = (app: any, body: any) =>
  request(app).post("/mcp").set(MCP_HEADERS).send(body);

describe("Standalone Mode ON (opt-in)", () => {
  let app: any;
  let isStandaloneModeActive: () => boolean;
  let enqueueEvent: (e: any) => void;
  let clearEventQueue: () => void;

  beforeAll(async () => {
    const k1 = "SLACK_APP_TOKEN";
    const k2 = "SLACK_BOT_TOKEN";
    process.env[k1] = process.env.T_APP || "xapp-dummy";
    process.env[k2] = process.env.T_BOT || "xoxb-dummy";
    const mod = await import("../index.js");
    app = mod.app;
    isStandaloneModeActive = mod.isStandaloneModeActive;
    enqueueEvent = mod.enqueueEvent;
    clearEventQueue = mod.clearEventQueue;
  });
  afterAll(() => {
    delete process.env.SLACK_APP_TOKEN;
  });

  it("isStandaloneModeActive() returns true", () => {
    expect(isStandaloneModeActive()).toBe(true);
  });

  it("POST /mcp tools/list DOES include wait_for_event", async () => {
    const res = await callMCP(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    expect(res.status).toBe(200);
    const body = parseSSEResponse(res.text);
    const tools = body?.result?.tools ?? [];
    const names = tools.map((t: any) => t.name);
    expect(names).toContain("wait_for_event");
  });

  it("GET /mcp returns 200 with text/event-stream and an endpoint event", async () => {
    // Use a custom parser that closes after receiving the first event,
    // since SSE streams otherwise stay open until the client disconnects.
    let received = "";
    const res = await request(app)
      .get("/mcp")
      .set("Accept", "text/event-stream")
      .buffer(true)
      .parse((res, callback) => {
        res.on("data", (chunk: Buffer) => {
          received += chunk.toString();
          if (received.includes("event: endpoint")) {
            res.destroy();
            callback(null, received);
          }
        });
        res.on("end", () => callback(null, received));
        res.on("error", () => callback(null, received));
        setTimeout(() => {
          res.destroy();
          callback(null, received);
        }, 2000);
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(received).toContain("event: endpoint");
    expect(received).toContain("data: /mcp");
  });

  it("wait_for_event returns enqueued event then removes it", async () => {
    clearEventQueue();
    enqueueEvent({
      type: "app_mention",
      event: { ts: "1234.5678", text: "hi" },
      receivedAt: Date.now(),
    });

    const res = await callMCP(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "wait_for_event",
        arguments: { type: "app_mention", timeoutMs: 500 },
      },
    });
    expect(res.status).toBe(200);
    const body = parseSSEResponse(res.text);
    // The tool result lives in result.content[0].text (as a stringified JSON)
    const text = body?.result?.content?.[0]?.text;
    expect(text).toBeDefined();
    const parsed = JSON.parse(text);
    // Wrapper shape: { event: SlackQueuedEvent, timedOut: false }
    // SlackQueuedEvent shape: { type, event, receivedAt }
    expect(parsed.event.type).toBe("app_mention");
    expect(parsed.event.event.ts).toBe("1234.5678");
    expect(parsed.timedOut).toBe(false);
  });

  it("wait_for_event times out when no matching event", async () => {
    clearEventQueue();
    const start = Date.now();
    const res = await callMCP(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "wait_for_event",
        arguments: { type: "app_mention", timeoutMs: 300 },
      },
    });
    const elapsed = Date.now() - start;
    expect(res.status).toBe(200);
    const body = parseSSEResponse(res.text);
    const text = body?.result?.content?.[0]?.text;
    const parsed = JSON.parse(text);
    expect(parsed.timedOut).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(250);
  });

  it("wait_for_event respects type filter (returns timedOut for non-matching)", async () => {
    clearEventQueue();
    enqueueEvent({
      type: "message",
      event: { ts: "1.0" },
      receivedAt: Date.now(),
    });
    const res = await callMCP(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "wait_for_event",
        arguments: { type: "app_mention", timeoutMs: 200 },
      },
    });
    const body = parseSSEResponse(res.text);
    const text = body?.result?.content?.[0]?.text;
    const parsed = JSON.parse(text);
    expect(parsed.timedOut).toBe(true);
  });

  it("wait_for_event respects sinceTs filter (string comparison)", async () => {
    clearEventQueue();
    enqueueEvent({
      type: "message",
      event: { ts: "100.0" },
      receivedAt: 0,
    });
    enqueueEvent({
      type: "message",
      event: { ts: "200.0" },
      receivedAt: 1,
    });
    enqueueEvent({
      type: "message",
      event: { ts: "300.0" },
      receivedAt: 2,
    });

    const res = await callMCP(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "wait_for_event",
        arguments: { sinceTs: "150.0", timeoutMs: 500 },
      },
    });
    const body = parseSSEResponse(res.text);
    const text = body?.result?.content?.[0]?.text;
    const parsed = JSON.parse(text);
    expect(parsed.event.event.ts).toBe("200.0");
  });

  it("wait_for_event is not double-delivered (queue pops on read)", async () => {
    clearEventQueue();
    enqueueEvent({
      type: "message",
      event: { ts: "1.0", text: "hello" },
      receivedAt: Date.now(),
    });

    const r1 = await callMCP(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "wait_for_event",
        arguments: { type: "message", timeoutMs: 200 },
      },
    });
    const r2 = await callMCP(app, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "wait_for_event",
        arguments: { type: "message", timeoutMs: 200 },
      },
    });
    const t1 = JSON.parse(parseSSEResponse(r1.text).result.content[0].text);
    const t2 = JSON.parse(parseSSEResponse(r2.text).result.content[0].text);
    expect(t1.timedOut).toBe(false);
    expect(t2.timedOut).toBe(true);
  });
});
