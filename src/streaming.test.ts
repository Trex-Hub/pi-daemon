import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnchorHandle } from "./anchor.js";
import type { DiscordTransport } from "./discord.js";
import { type AskBridge, EDIT_INTERVAL_MS, StreamRouter } from "./streaming.js";

function fakeTransport() {
  const anchor: AnchorHandle = { messageId: "anchor-1", edit: vi.fn().mockResolvedValue(undefined) };
  let nextAskMessageId = 0;
  return {
    anchor,
    sendAnchor: vi.fn().mockResolvedValue(anchor),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    createToolThread: vi.fn().mockResolvedValue("thread-1"),
    postThreadBatch: vi.fn().mockResolvedValue(undefined),
    sendAskPrompt: vi.fn().mockImplementation(() => Promise.resolve(`ask-msg-${nextAskMessageId++}`)),
    finalizeAskPrompt: vi.fn().mockResolvedValue(undefined),
  };
}

function asTransport(fake: ReturnType<typeof fakeTransport>): DiscordTransport {
  return fake as unknown as DiscordTransport;
}

function fakeAskBridge() {
  return {
    respond: vi.fn<AskBridge["respond"]>().mockReturnValue(true),
    setAwaitingInput: vi.fn<AskBridge["setAwaitingInput"]>(),
  };
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

describe("StreamRouter file markers", () => {
  it("hides a partial marker while streaming", async () => {
    const fake = fakeTransport();
    const router = new StreamRouter(asTransport(fake));

    await router.handleEvent(CHANNEL, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Done\n[[discord-file:report" },
    });
    await vi.advanceTimersByTimeAsync(EDIT_INTERVAL_MS);

    expect(fake.anchor.edit).toHaveBeenCalledWith(expect.objectContaining({ currentStep: "Done" }));
  });

  it("requests one final own-line marker after finalizing the anchor", async () => {
    const fake = fakeTransport();
    const onFileRequest = vi.fn().mockResolvedValue(undefined);
    const router = new StreamRouter(asTransport(fake), onFileRequest);

    await router.handleEvent(CHANNEL, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Created it.\n[[discord-file:report.txt]]" },
    });
    await router.handleEvent(CHANNEL, { type: "agent_settled" });

    expect(fake.anchor.edit).toHaveBeenLastCalledWith(expect.objectContaining({ currentStep: "Created it." }));
    expect(onFileRequest).toHaveBeenCalledWith(CHANNEL, "report.txt");
  });

  it("rejects non-final and multiple markers", async () => {
    const onFileRequest = vi.fn().mockResolvedValue(undefined);
    const router = new StreamRouter(asTransport(fakeTransport()), onFileRequest);

    await router.handleEvent(CHANNEL, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "[[discord-file:first.txt]]\ntext" },
    });
    await router.handleEvent(CHANNEL, { type: "agent_settled" });
    await router.handleEvent(CHANNEL, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "[[discord-file:first.txt]]\n[[discord-file:second.txt]]" },
    });
    await router.handleEvent(CHANNEL, { type: "agent_settled" });
    expect(onFileRequest).not.toHaveBeenCalled();
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

describe("StreamRouter ask_user dialogs", () => {
  it("renders a dialog method's extension_ui_request via sendAskPrompt", async () => {
    const fake = fakeTransport();
    const ask = fakeAskBridge();
    const router = new StreamRouter(asTransport(fake), undefined, ask);

    await router.handleEvent(CHANNEL, {
      type: "extension_ui_request",
      id: "uuid-1",
      method: "confirm",
      title: "Clear session?",
      message: "All messages will be lost.",
    });

    expect(fake.sendAskPrompt).toHaveBeenCalledWith(CHANNEL, "uuid-1", {
      method: "confirm",
      title: "Clear session?",
      context: undefined,
      message: "All messages will be lost.",
      options: undefined,
    });
    expect(ask.setAwaitingInput).toHaveBeenCalledWith(CHANNEL, true);
  });

  it("ignores fire-and-forget extension_ui_request methods", async () => {
    const fake = fakeTransport();
    const ask = fakeAskBridge();
    const router = new StreamRouter(asTransport(fake), undefined, ask);

    await router.handleEvent(CHANNEL, { type: "extension_ui_request", id: "uuid-2", method: "notify", message: "hi" });

    expect(fake.sendAskPrompt).not.toHaveBeenCalled();
    expect(ask.setAwaitingInput).not.toHaveBeenCalled();
  });

  it("queues a second concurrent ask — it renders only after the first resolves", async () => {
    const fake = fakeTransport();
    const ask = fakeAskBridge();
    const router = new StreamRouter(asTransport(fake), undefined, ask);

    await router.handleEvent(CHANNEL, { type: "extension_ui_request", id: "uuid-1", method: "confirm", title: "First?" });
    await router.handleEvent(CHANNEL, { type: "extension_ui_request", id: "uuid-2", method: "confirm", title: "Second?" });

    expect(fake.sendAskPrompt).toHaveBeenCalledTimes(1);
    expect(fake.sendAskPrompt).toHaveBeenCalledWith(CHANNEL, "uuid-1", expect.objectContaining({ title: "First?" }));

    await router.resolveAsk(CHANNEL, "uuid-1", "yes");

    expect(fake.sendAskPrompt).toHaveBeenCalledTimes(2);
    expect(fake.sendAskPrompt).toHaveBeenLastCalledWith(CHANNEL, "uuid-2", expect.objectContaining({ title: "Second?" }));
  });

  it("resolveAsk rejects an id that isn't the current queue head", async () => {
    const fake = fakeTransport();
    const ask = fakeAskBridge();
    const router = new StreamRouter(asTransport(fake), undefined, ask);

    await router.handleEvent(CHANNEL, { type: "extension_ui_request", id: "uuid-1", method: "confirm", title: "First?" });

    const resolved = await router.resolveAsk(CHANNEL, "stale-id", "yes");

    expect(resolved).toBe(false);
    expect(ask.respond).not.toHaveBeenCalled();
  });

  it("resolveAsk delivers the right payload shape per method/choice", async () => {
    const fake = fakeTransport();
    const ask = fakeAskBridge();
    const router = new StreamRouter(asTransport(fake), undefined, ask);

    await router.handleEvent(CHANNEL, {
      type: "extension_ui_request",
      id: "uuid-1",
      method: "select",
      title: "Pick one",
      options: ["Allow", "Block"],
    });
    await router.resolveAsk(CHANNEL, "uuid-1", "1");

    expect(ask.respond).toHaveBeenCalledWith(CHANNEL, "uuid-1", { value: "Block" });
  });

  it("tryResolveAskText only consumes text while an input/editor ask is open", async () => {
    const fake = fakeTransport();
    const ask = fakeAskBridge();
    const router = new StreamRouter(asTransport(fake), undefined, ask);

    expect(await router.tryResolveAskText(CHANNEL, "hello")).toBe(false);

    await router.handleEvent(CHANNEL, { type: "extension_ui_request", id: "uuid-1", method: "input", title: "Enter a value" });

    expect(await router.tryResolveAskText(CHANNEL, "my answer")).toBe(true);
    expect(ask.respond).toHaveBeenCalledWith(CHANNEL, "uuid-1", { value: "my answer" });
    expect(fake.finalizeAskPrompt).toHaveBeenCalledWith(CHANNEL, "ask-msg-0", "Answered: my answer");
  });
});
