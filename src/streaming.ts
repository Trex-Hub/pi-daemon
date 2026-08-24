import type { DiscordTransport, PlaceholderHandle } from "./discord.js";

const EDIT_INTERVAL_MS = 1000;

interface TurnState {
  text: string;
  dirty: boolean;
  placeholder: PlaceholderHandle;
  timer?: NodeJS.Timeout;
  /** undefined = not yet requested, null = requested but unsupported (e.g. DM). */
  threadId?: string | null;
}

/** Routes one channel's streamed Pi RPC events to Discord: buffered text edits + a thread for tool output. */
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
      await this.postToolOutput(channelId, `▶ ${e.toolName} ${JSON.stringify(e.args)}`);
    } else if (e.type === "tool_execution_end") {
      const text = e.isError
        ? `✗ ${e.toolName} failed: ${JSON.stringify(e.result)}`
        : `✓ ${e.toolName}: ${JSON.stringify(e.result)}`;
      await this.postToolOutput(channelId, text);
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
    const state: TurnState = { text: "", dirty: false, placeholder };
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

  private async postToolOutput(channelId: string, text: string): Promise<void> {
    const turn = await this.ensureTurn(channelId);
    if (turn.threadId === undefined) {
      turn.threadId = await this.transport.createThread(channelId, "tool output");
    }
    await this.transport.sendMessage(turn.threadId ?? channelId, text);
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
