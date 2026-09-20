import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnchorHandle } from "./anchor.js";
import type { DiscordTransport } from "./discord.js";
import { EDIT_INTERVAL_MS, StreamRouter } from "./streaming.js";

function fakeTransport() {
  const anchor: AnchorHandle = { messageId: "anchor-1", edit: vi.fn().mockResolvedValue(undefined) };
  return {
    anchor,
    sendAnchor: vi.fn().mockResolvedValue(anchor),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    createToolThread: vi.fn().mockResolvedValue("thread-1"),
    postThreadBatch: vi.fn().mockResolvedValue(undefined),
  };
}

function asTransport(fake: ReturnType<typeof fakeTransport>): DiscordTransport {
  return fake as unknown as DiscordTransport;
}

const CHANNEL = "chan-1";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("StreamRouter anchor edits", () => {
  it("throttles multiple text deltas within one tick into a single anchor.edit()", async () => {
    const fake = fakeTransport();
    const router = new StreamRouter(asTransport(fake));

    await router.handleEvent(CHANNEL, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello " } });
    await router.handleEvent(CHANNEL, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } });

    expect(fake.anchor.edit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(EDIT_INTERVAL_MS);

    expect(fake.anchor.edit).toHaveBeenCalledTimes(1);
    expect(fake.anchor.edit).toHaveBeenCalledWith(expect.objectContaining({ currentStep: "Hello world" }));
  });
});

describe("StreamRouter thread lifecycle", () => {
  it("never creates a thread for a turn with zero tool calls", async () => {
    const fake = fakeTransport();
    const router = new StreamRouter(asTransport(fake));

    await router.handleEvent(CHANNEL, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "just text" } });
    await router.handleEvent(CHANNEL, { type: "agent_settled" });

    expect(fake.createToolThread).not.toHaveBeenCalled();
  });

  it("creates the thread only once even with multiple tool calls in the same turn", async () => {
    const fake = fakeTransport();
    const router = new StreamRouter(asTransport(fake));

    await router.handleEvent(CHANNEL, { type: "tool_execution_start", toolCallId: "a1", toolName: "read", args: { path: "a.ts" } });
    await Promise.resolve();
    await router.handleEvent(CHANNEL, { type: "tool_execution_start", toolCallId: "a2", toolName: "read", args: { path: "b.ts" } });
    await Promise.resolve();

    expect(fake.createToolThread).toHaveBeenCalledTimes(1);
  });

  it("names the thread from the prompt passed to beginTurn", async () => {
    const fake = fakeTransport();
    const router = new StreamRouter(asTransport(fake));

    router.beginTurn(CHANNEL, "please read this file and summarize it");
    await router.handleEvent(CHANNEL, { type: "tool_execution_start", toolCallId: "a1", toolName: "read", args: { path: "a.ts" } });
    await Promise.resolve();

    expect(fake.createToolThread).toHaveBeenCalledWith(CHANNEL, "anchor-1", "please read this file and summarize it");
  });
});

describe("StreamRouter thread batching", () => {
  it("batches several tool-call lines accumulated between ticks into one postThreadBatch call", async () => {
    const fake = fakeTransport();
    const router = new StreamRouter(asTransport(fake));

    await router.handleEvent(CHANNEL, { type: "tool_execution_start", toolCallId: "a1", toolName: "read", args: { path: "a.ts" } });
    await Promise.resolve();
    await router.handleEvent(CHANNEL, { type: "tool_execution_end", toolCallId: "a1", toolName: "read", result: "ok", isError: false });
    await router.handleEvent(CHANNEL, { type: "tool_execution_start", toolCallId: "a2", toolName: "grep", args: { pattern: "foo" } });
    await router.handleEvent(CHANNEL, { type: "tool_execution_end", toolCallId: "a2", toolName: "grep", result: "no matches", isError: false });

    await vi.advanceTimersByTimeAsync(EDIT_INTERVAL_MS);

    expect(fake.postThreadBatch).toHaveBeenCalledTimes(1);
    const [, lines] = fake.postThreadBatch.mock.calls[0];
    expect(lines).toHaveLength(4);
  });

  it("never dumps raw JSON into the thread — lines are formatted, human-readable summaries", async () => {
    const fake = fakeTransport();
    const router = new StreamRouter(asTransport(fake));

    await router.handleEvent(CHANNEL, { type: "tool_execution_start", toolCallId: "a1", toolName: "read", args: { path: "src/discord.ts" } });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(EDIT_INTERVAL_MS);

    const [, lines] = fake.postThreadBatch.mock.calls[0];
    expect(lines[0]).toBe("▶ read src/discord.ts");
    expect(lines[0]).not.toContain("{");
  });

  it("correlates concurrent same-named tool calls by toolCallId, not name — no clobbering", async () => {
    const fake = fakeTransport();
    const router = new StreamRouter(asTransport(fake));

    await router.handleEvent(CHANNEL, { type: "tool_execution_start", toolCallId: "a1", toolName: "read", args: { path: "a.ts" } });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(150);
    await router.handleEvent(CHANNEL, { type: "tool_execution_start", toolCallId: "a2", toolName: "read", args: { path: "b.ts" } });
    await vi.advanceTimersByTimeAsync(50);
    await router.handleEvent(CHANNEL, { type: "tool_execution_end", toolCallId: "a1", toolName: "read", result: "A", isError: false });
    await vi.advanceTimersByTimeAsync(50);
    await router.handleEvent(CHANNEL, { type: "tool_execution_end", toolCallId: "a2", toolName: "read", result: "B", isError: false });

    await vi.advanceTimersByTimeAsync(EDIT_INTERVAL_MS);

    const [, lines] = fake.postThreadBatch.mock.calls[0];
    const endA = lines.find((l: string) => l.includes(": A"));
    const endB = lines.find((l: string) => l.includes(": B"));
    expect(endA).toContain("(200ms)");
    expect(endB).toContain("(100ms)");
  });
});
