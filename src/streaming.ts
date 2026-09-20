import type { AnchorHandle } from "./anchor.js";
import type { DiscordTransport } from "./discord.js";

export const EDIT_INTERVAL_MS = 1000;
const TYPING_REFRESH_MS = 8000;
const ARG_VALUE_MAX = 60;

type PendingCall = {
  toolName: string;
  startedAt: number;
};

type TurnState = {
  anchor: AnchorHandle;
  status: "running" | "done" | "error";
  hadError: boolean;
  text: string;
  lastToolLine: string;
  toolCallCount: number;
  dirty: boolean;
  calls: Map<string, PendingCall>;
  /** undefined = not yet requested, null = channel can't have threads or creation failed. */
  threadId?: string | null;
  /** Guards concurrent tool_execution_starts (pi runs tools in parallel) from creating two threads. */
  threadPromise?: Promise<void>;
  threadLines: string[];
  threadDirty: boolean;
  promptPreview: string;
  timer?: NodeJS.Timeout;
  lastTypingAt: number;
};

const truncateValue = (value: unknown, max = ARG_VALUE_MAX): string => {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** Formats a tool call's args as a short human-readable summary — never raw JSON. */
const summarizeArgs = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value !== "object") return truncateValue(value);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "";
  if (entries.length === 1 && typeof entries[0][1] !== "object") return truncateValue(entries[0][1]);
  return entries
    .slice(0, 3)
    .map(([k, v]) => `${k}=${truncateValue(v)}`)
    .join(" ");
};

const formatToolStart = (toolName: string, args: unknown): string => {
  const summary = summarizeArgs(args);
  return summary ? `▶ ${toolName} ${summary}` : `▶ ${toolName}`;
};

const formatToolEnd = (toolName: string, result: unknown, isError: boolean, durationMs: number): string => {
  const summary = summarizeArgs(result);
  const icon = isError ? "✗" : "✓";
  return summary ? `${icon} ${toolName} (${durationMs}ms): ${summary}` : `${icon} ${toolName} (${durationMs}ms)`;
};

/** Routes one channel's streamed Pi RPC events to Discord: one throttled-edit anchor card + a lazily-created thread carrying the readable tool-call log. */
export class StreamRouter {
  private turns = new Map<string, Promise<TurnState>>();
  private pendingPrompts = new Map<string, string>();

  constructor(private transport: DiscordTransport) {}

  /** Call right before sending the prompt to `pi`, so the eventual anchor/thread can be named from it. */
  beginTurn(channelId: string, promptPreview: string): void {
    this.pendingPrompts.set(channelId, promptPreview);
  }

  async handleEvent(channelId: string, event: unknown): Promise<void> {
    if (!event || typeof event !== "object" || !("type" in event)) return;
    const e = event as { type: string; assistantMessageEvent?: { type: string; delta?: string } } & Record<
      string,
      unknown
    >;

    if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
      const turn = await this.ensureTurn(channelId);
      turn.text += e.assistantMessageEvent.delta ?? "";
      turn.dirty = true;
    } else if (e.type === "tool_execution_start") {
      const toolCallId = String(e.toolCallId);
      const toolName = String(e.toolName);
      const turn = await this.ensureTurn(channelId);
      turn.calls.set(toolCallId, { toolName, startedAt: Date.now() });
      turn.lastToolLine = formatToolStart(toolName, e.args);
      turn.toolCallCount += 1;
      turn.dirty = true;
      turn.threadLines.push(turn.lastToolLine);
      turn.threadDirty = true;
      this.ensureThread(channelId, turn);
    } else if (e.type === "tool_execution_end") {
      const toolCallId = String(e.toolCallId);
      const turn = await this.ensureTurn(channelId);
      const call = turn.calls.get(toolCallId);
      turn.calls.delete(toolCallId);
      const toolName = call?.toolName ?? String(e.toolName);
      const isError = Boolean(e.isError);
      const durationMs = call ? Date.now() - call.startedAt : 0;
      turn.lastToolLine = formatToolEnd(toolName, e.result, isError, durationMs);
      turn.hadError ||= isError;
      turn.dirty = true;
      turn.threadLines.push(turn.lastToolLine);
      turn.threadDirty = true;
    } else if (e.type === "agent_settled") {
      const turn = await this.ensureTurn(channelId);
      turn.status = turn.hadError ? "error" : "done";
      turn.dirty = true;
      await this.endTurn(channelId);
    }
  }

  private ensureTurn(channelId: string): Promise<TurnState> {
    let turn = this.turns.get(channelId);
    if (!turn) {
      turn = this.createTurn(channelId);
      this.turns.set(channelId, turn);
    }
    return turn;
  }

  private async createTurn(channelId: string): Promise<TurnState> {
    const promptPreview = this.pendingPrompts.get(channelId) ?? "tool activity";
    this.pendingPrompts.delete(channelId);

    const anchor = await this.transport.sendAnchor(channelId);
    const state: TurnState = {
      anchor,
      status: "running",
      hadError: false,
      text: "",
      lastToolLine: "",
      toolCallCount: 0,
      dirty: false,
      calls: new Map(),
      threadLines: [],
      threadDirty: false,
      promptPreview,
      lastTypingAt: 0,
    };
    this.refreshTyping(channelId, state);
    state.timer = setInterval(() => {
      this.flush(state).catch((err) => console.error("[streaming] flush failed:", err));
      this.refreshTyping(channelId, state);
    }, EDIT_INTERVAL_MS);
    return state;
  }

  /** Creates the thread on the turn's first tool call only. Safe to call repeatedly — subsequent calls no-op while creation is in flight or once resolved. */
  private ensureThread(channelId: string, turn: TurnState): void {
    if (turn.threadId !== undefined || turn.threadPromise) return;
    turn.threadPromise = this.transport
      .createToolThread(channelId, turn.anchor.messageId, turn.promptPreview)
      .then((threadId) => {
        turn.threadId = threadId;
        if (threadId === null) {
          // channel can't have threads (DM/voice) or creation failed — drop accumulated lines rather than growing forever.
          turn.threadLines = [];
          turn.threadDirty = false;
        }
      })
      .catch((err) => {
        console.error("[streaming] thread creation failed:", err);
        turn.threadId = null;
        turn.threadLines = [];
        turn.threadDirty = false;
      });
  }

  private refreshTyping(channelId: string, turn: TurnState): void {
    if (Date.now() - turn.lastTypingAt < TYPING_REFRESH_MS) return;
    turn.lastTypingAt = Date.now();
    this.transport.sendTyping(channelId).catch((err) => console.error("[streaming] typing indicator failed:", err));
  }

  private async flush(turn: TurnState): Promise<void> {
    if (turn.dirty) {
      turn.dirty = false;
      await turn.anchor.edit({
        status: turn.status,
        toolCallCount: turn.toolCallCount,
        currentStep: turn.text || turn.lastToolLine || "…",
      });
    }
    if (turn.threadDirty && turn.threadId) {
      turn.threadDirty = false;
      const batch = turn.threadLines;
      turn.threadLines = [];
      await this.transport.postThreadBatch(turn.threadId, batch);
    }
  }

  private async endTurn(channelId: string): Promise<void> {
    const pending = this.turns.get(channelId);
    if (!pending) return;
    this.turns.delete(channelId);
    const turn = await pending;
    if (turn.timer) clearInterval(turn.timer);
    if (turn.threadPromise) await turn.threadPromise.catch(() => {});
    await this.flush(turn);
  }
}
