/**
 * Unit tests for the in-memory event queue.
 *
 * No HTTP, no Socket Mode — just the pure queue + filter logic.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  enqueueEvent,
  drainEvent,
  clearEventQueue,
  eventQueueSize,
} from "../index.js";

describe("event queue", () => {
  beforeEach(() => clearEventQueue());

  it("enqueue into empty queue → length 1", () => {
    enqueueEvent({
      type: "app_mention",
      event: { ts: "1.0" },
      receivedAt: 0,
    });
    expect(eventQueueSize()).toBe(1);
  });

  it("enqueue past capacity (1000) → drops oldest, length stays 1000", () => {
    for (let i = 0; i < 1001; i++) {
      enqueueEvent({
        type: "app_mention",
        event: { ts: `${i}.0` },
        receivedAt: i,
      });
    }
    expect(eventQueueSize()).toBe(1000);
    // The oldest event (i=0) should have been dropped.
    const ev = drainEvent({});
    expect(ev).not.toBeNull();
    expect(ev?.event.ts).toBe("1.0");
  });

  it("enqueue past capacity by 10 → drops 10 oldest, length 1000", () => {
    for (let i = 0; i < 1010; i++) {
      enqueueEvent({
        type: "message",
        event: { ts: `${i}.0` },
        receivedAt: i,
      });
    }
    expect(eventQueueSize()).toBe(1000);
    // Oldest remaining event should be i=10.
    const ev = drainEvent({});
    expect(ev?.event.ts).toBe("10.0");
  });

  it("empty queue, drain with filter → returns null", () => {
    const ev = drainEvent({ type: "app_mention" });
    expect(ev).toBeNull();
  });

  it("queue with 3 events, drain filter matches 2nd → returns 2nd", () => {
    enqueueEvent({
      type: "app_mention",
      event: { ts: "1.0" },
      receivedAt: 0,
    });
    enqueueEvent({
      type: "message",
      event: { ts: "2.0" },
      receivedAt: 1,
    });
    enqueueEvent({
      type: "app_mention",
      event: { ts: "3.0" },
      receivedAt: 2,
    });

    const ev = drainEvent({ type: "message" });
    expect(ev).not.toBeNull();
    expect(ev?.type).toBe("message");
    expect(ev?.event.ts).toBe("2.0");
    // The other two events are still queued.
    expect(eventQueueSize()).toBe(2);
  });

  it("drain removes the matched event (no double-delivery)", () => {
    enqueueEvent({
      type: "app_mention",
      event: { ts: "1.0" },
      receivedAt: 0,
    });
    const first = drainEvent({ type: "app_mention" });
    const second = drainEvent({ type: "app_mention" });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("drain with sinceTs filter (string comparison)", () => {
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

    const ev = drainEvent({ sinceTs: "150.0" });
    expect(ev?.event.ts).toBe("200.0");
  });
});
