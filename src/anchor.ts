import { ContainerBuilder, SeparatorBuilder, TextDisplayBuilder } from "discord.js";

export const DISCORD_MESSAGE_LIMIT = 2000;

/** Live status shown on the one persistent anchor message for a turn. */
export type AnchorState = {
  status: "running" | "done" | "error";
  toolCallCount: number;
  /** Most recent tool-call summary, or — once the model starts producing text — the streamed/final assistant text. */
  currentStep: string;
};

/** The turn's one persistent status message. `messageId` anchors a lazily-created thread to it. */
export type AnchorHandle = {
  readonly messageId: string;
  edit(state: AnchorState): Promise<void>;
};

/** Splits text into Discord-sized chunks, preferring newline/space boundaries. */
export const chunkMessage = (text: string, limit: number = DISCORD_MESSAGE_LIMIT): string[] => {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    const newlineIdx = remaining.lastIndexOf("\n", limit);
    const spaceIdx = remaining.lastIndexOf(" ", limit);
    const splitAt = newlineIdx > limit * 0.5 ? newlineIdx + 1 : spaceIdx > limit * 0.5 ? spaceIdx + 1 : limit;

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);

  return chunks;
};

export const buildAnchorContainer = (state: AnchorState): ContainerBuilder => {
  const statusLabel = state.status === "running" ? "⏳ running" : state.status === "error" ? "🔴 error" : "🟢 done";
  const countLabel = `${state.toolCallCount} tool call${state.toolCallCount === 1 ? "" : "s"}${state.status === "running" ? " so far" : ""}`;
  const header = `${statusLabel} · ${countLabel}`;
  const body = chunkMessage(state.currentStep || "…", DISCORD_MESSAGE_LIMIT)[0] ?? "…";

  return new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(header))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
};
