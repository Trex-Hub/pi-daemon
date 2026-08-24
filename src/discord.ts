import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  Partials,
} from "discord.js";
import type { GatewayAuth } from "./auth.js";

const DISCORD_MESSAGE_LIMIT = 2000;

/** Incoming Discord message, normalized for routing/session handling downstream (ticket 005+). */
export interface IncomingMessage {
  userId: string;
  chatId: string;
  username: string;
  content: string;
  isGroupChat: boolean;
  wasMentioned: boolean;
  /** Category name from `channel.parentId`, or null when ungrouped/DM. Fallback bucketing is ticket 005's job. */
  category: string | null;
  channelName: string;
  messageId: string;
  timestamp: Date;
}

const VOICE_CHANNEL_TYPES: ReadonlySet<ChannelType> = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);

export class DiscordTransport {
  private client: Client | null = null;
  private botUserId = "";
  private messageHandler?: (message: IncomingMessage) => void;

  constructor(
    private token: string,
    private auth: GatewayAuth
  ) {}

  onMessage(handler: (message: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  async connect(): Promise<void> {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
    this.client = client;

    client.once(Events.ClientReady, (ready) => {
      this.botUserId = ready.user.id;
      console.log(`[discord] logged in as ${ready.user.tag}`);
    });

    client.on(Events.Error, (err) => {
      console.error("[discord] client error:", err);
    });

    client.on(Events.MessageCreate, (message) => {
      this.handleMessage(message).catch((err) => {
        console.error("[discord] message handling failed:", err);
      });
    });

    await client.login(this.token);
  }

  async disconnect(): Promise<void> {
    await this.client?.destroy();
    this.client = null;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.client) throw new Error("Discord not connected");
    if (!text.trim()) return;

    const channel = await this.client.channels.fetch(chatId);
    if (!channel?.isTextBased() || !("send" in channel)) throw new Error(`Cannot send to channel ${chatId}`);

    for (const chunk of chunkMessage(text, DISCORD_MESSAGE_LIMIT)) {
      await channel.send(chunk);
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (VOICE_CHANNEL_TYPES.has(message.channel.type)) return;

    const content = message.content.trim();
    if (!content) return;

    const isDM = message.channel.type === ChannelType.DM;
    const isGroupChat = !isDM;
    const wasMentioned = this.botUserId ? message.mentions.users.has(this.botUserId) : false;

    const userId = message.author.id;
    const chatId = message.channelId;
    const username = message.author.username;

    const sendToChat = async (cId: string, text: string) => {
      await this.sendMessage(cId, text);
    };

    if (!isGroupChat) {
      const handled = await this.auth.handleAdminCommand(content, chatId, userId, "discord", (text) =>
        this.sendMessage(chatId, text)
      );
      if (handled) return;
    }

    const isAuthorized = await this.auth.checkAuthorization(
      userId,
      chatId,
      username,
      isGroupChat,
      wasMentioned,
      "discord",
      sendToChat
    );
    if (!isAuthorized) return;

    if (!this.messageHandler) return;

    const category = "parent" in message.channel ? (message.channel.parent?.name ?? null) : null;
    const channelName = "name" in message.channel ? (message.channel.name ?? chatId) : chatId;

    this.messageHandler({
      userId,
      chatId,
      username,
      content,
      isGroupChat,
      wasMentioned,
      category,
      channelName,
      messageId: message.id,
      timestamp: message.createdAt,
    });
  }
}

/** Splits text into Discord-sized chunks, preferring newline/space boundaries. */
export function chunkMessage(text: string, limit: number = DISCORD_MESSAGE_LIMIT): string[] {
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
}
