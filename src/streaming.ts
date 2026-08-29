import type { DiscordTransport, PlaceholderHandle, ToolCardHandle } from "./discord.js";

const EDIT_INTERVAL_MS = 1000;

interface TurnState {
  text: string;
  dirty: boolean;
  placeholder: PlaceholderHandle;
  timer?: NodeJS.Timeout;
  toolCalls: Map<string, { startedAt: number; args: string; handlePromise: Promise<ToolCardHandle> }>;
}

/** Routes one channel's streamed Pi RPC events to Discord: buffered text edits + inline tool status cards. */
export class StreamRouter {
  private turns = new Map<string, Promise<TurnState>>();

  constructor(private transport: DiscordTransport) {}

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
      const toolName = String(e.toolName);
      const args = JSON.stringify(e.args, null, 2);
      const turn = await this.ensureTurn(channelId);
      const handlePromise = this.transport.sendToolCard(channelId, { toolName, status: "running", args });
      // set before awaiting the send — an instant tool can fire tool_execution_end before the card finishes posting.
      // ponytail: keyed by tool name, not call id — concurrent calls to the same tool clobber each other. Upgrade if that shows up.
      turn.toolCalls.set(toolName, { startedAt: Date.now(), args, handlePromise });
      await handlePromise;
    } else if (e.type === "tool_execution_end") {
      const toolName = String(e.toolName);
      const turn = await this.ensureTurn(channelId);
      const call = turn.toolCalls.get(toolName);
      turn.toolCalls.delete(toolName);
      const updated = {
        toolName,
        status: e.isError ? ("error" as const) : ("success" as const),
        args: call?.args ?? JSON.stringify(e.args, null, 2),
        result: JSON.stringify(e.result, null, 2),
        duration: call ? Date.now() - call.startedAt : undefined,
      };
      if (call) await (await call.handlePromise).edit(updated);
      else await this.transport.sendToolCard(channelId, updated);
    } else if (e.type === "agent_settled") {
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
    const placeholder = await this.transport.sendPlaceholder(channelId);
    const state: TurnState = { text: "", dirty: false, placeholder, toolCalls: new Map() };
    state.timer = setInterval(() => {
      this.flush(state).catch((err) => console.error("[streaming] edit failed:", err));
    }, EDIT_INTERVAL_MS);
    return state;
  }

  private async flush(turn: TurnState): Promise<void> {
    if (!turn.dirty) return;
    turn.dirty = false;
    await turn.placeholder.edit(turn.text);
  }

  private async endTurn(channelId: string): Promise<void> {
    const pending = this.turns.get(channelId);
    if (!pending) return;
    this.turns.delete(channelId);
    const turn = await pending;
    if (turn.timer) clearInterval(turn.timer);
    await this.flush(turn);
  }
}
