import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type Interaction,
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

/** A sent placeholder message, editable in place for streamed updates. */
export interface PlaceholderHandle {
  edit(text: string): Promise<void>;
}

/** A click on one of the new-channel confirm buttons (008). */
export interface ButtonAction {
  channelId: string;
  action: "create" | "attach" | "ignore";
  category: string | null;
  channelName: string;
  reply(text: string): Promise<void>;
}

export class DiscordTransport {
  private client: Client | null = null;
  private botUserId = "";
  private messageHandler?: (message: IncomingMessage) => void;
  private buttonHandler?: (action: ButtonAction) => void;

  constructor(
    private token: string,
    private auth: GatewayAuth
  ) {}

  onMessage(handler: (message: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  onButtonAction(handler: (action: ButtonAction) => void): void {
    this.buttonHandler = handler;
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

    client.on(Events.InteractionCreate, (interaction) => {
      this.handleInteraction(interaction).catch((err) => {
        console.error("[discord] interaction handling failed:", err);
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

  /** Sends a placeholder message to edit in place while text streams in. */
  async sendPlaceholder(chatId: string): Promise<PlaceholderHandle> {
    if (!this.client) throw new Error("Discord not connected");

    const channel = await this.client.channels.fetch(chatId);
    if (!channel?.isTextBased() || !("send" in channel)) throw new Error(`Cannot send to channel ${chatId}`);

    const message = await channel.send("…");
    return {
      edit: async (text: string) => {
        await message.edit(chunkMessage(text, DISCORD_MESSAGE_LIMIT)[0] ?? "…");
      },
    };
  }

  /** Creates a thread off `chatId` for tool/bash output. Returns null where threads aren't supported (DMs, voice). */
  async createThread(chatId: string, name: string): Promise<string | null> {
    if (!this.client) throw new Error("Discord not connected");

    const channel = await this.client.channels.fetch(chatId);
    if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
      return null;
    }

    const thread = await channel.threads.create({ name });
    return thread.id;
  }

  /** Posts the new/unmapped-channel confirm prompt with create/attach/ignore buttons (008). */
  async sendConfirm(chatId: string, category: string | null, channelName: string): Promise<void> {
    if (!this.client) throw new Error("Discord not connected");

    const channel = await this.client.channels.fetch(chatId);
    if (!channel?.isTextBased() || !("send" in channel)) throw new Error(`Cannot send to channel ${chatId}`);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`pi:create:${chatId}`)
        .setLabel(`Create ${category ?? "ungrouped"}/${channelName}`)
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`pi:attach:${chatId}`).setLabel("Attach to existing folder").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`pi:ignore:${chatId}`).setLabel("Ignore").setStyle(ButtonStyle.Secondary)
    );

    await channel.send({
      content: "This channel isn't mapped to a project directory yet. I've started an ephemeral session so you get an answer now — pick one:",
      components: [row],
    });
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isButton()) return;
    const [ns, action, channelId] = interaction.customId.split(":");
    if (ns !== "pi" || !this.buttonHandler) return;
    if (action !== "create" && action !== "attach" && action !== "ignore") return;

    await interaction.deferUpdate();

    const channel = interaction.channel;
    const category = channel && "parent" in channel ? (channel.parent?.name ?? null) : null;
    const channelName = channel && "name" in channel ? (channel.name ?? channelId) : channelId;

    this.buttonHandler({
      channelId,
      action,
      category,
      channelName,
      reply: async (text: string) => {
        await interaction.followUp(text);
      },
    });
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
