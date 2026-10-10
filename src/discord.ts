import {
  ActionRowBuilder,
  type AutocompleteInteraction,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  type Interaction,
  type Message,
  MessageFlags,
  Partials,
} from "discord.js";
import { type AnchorHandle, type AnchorState, buildAnchorContainer, chunkMessage, DISCORD_MESSAGE_LIMIT } from "./anchor.js";
import type { OutboundFile } from "./attachments.js";
import type { GatewayAuth } from "./auth.js";
import { buildSlashCommands } from "./commands.js";

export type IncomingAttachment = {
  id: string;
  name: string;
  size: number;
  url: string;
};

/** Incoming Discord message, normalized for routing/session handling downstream (ticket 005+). */
export type IncomingMessage = {
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
  attachments: IncomingAttachment[];
};

const VOICE_CHANNEL_TYPES: ReadonlySet<ChannelType> = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);

/** A click on one of the new-channel confirm buttons (008). */
export type ButtonAction = {
  channelId: string;
  action: "create" | "attach" | "ignore";
  category: string | null;
  channelName: string;
  reply(text: string): Promise<void>;
};

/** One `/stop`, `/continue`, or `/model` invocation, normalized for routing downstream. */
export type SlashCommandInvocation = {
  commandName: string;
  /** Discord subcommand name, e.g. "set"/"list" for /model — null when the command has none. */
  subcommand: string | null;
  channelId: string;
  userId: string;
  getStringOption(name: string): string | null;
  reply(text: string): Promise<void>;
};

/** An in-progress `/model set` autocomplete request for one option ("provider" or "model"). */
export type AutocompleteInvocation = {
  commandName: string;
  optionName: string;
  /** What the user has typed so far in the focused option. */
  value: string;
  channelId: string;
  getStringOption(name: string): string | null;
  respond(choices: { name: string; value: string }[]): Promise<void>;
};

export class DiscordTransport {
  private client: Client | null = null;
  private botUserId = "";
  private messageHandler?: (message: IncomingMessage) => void;
  private buttonHandler?: (action: ButtonAction) => void;
  private slashCommandHandler?: (invocation: SlashCommandInvocation) => void;
  private autocompleteHandler?: (invocation: AutocompleteInvocation) => void;

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

  onSlashCommand(handler: (invocation: SlashCommandInvocation) => void): void {
    this.slashCommandHandler = handler;
  }

  onAutocomplete(handler: (invocation: AutocompleteInvocation) => void): void {
    this.autocompleteHandler = handler;
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
      this.registerSlashCommands().catch((err) => console.error("[discord] slash command registration failed:", err));
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

  /** Fires Discord's typing indicator in `chatId`. Fades after ~10s — caller must refresh. */
  async sendTyping(chatId: string): Promise<void> {
    if (!this.client) return;
    const channel = await this.client.channels.fetch(chatId);
    if (!channel?.isTextBased() || !("sendTyping" in channel)) return;
    await channel.sendTyping();
  }

  async sendFile(chatId: string, file: OutboundFile): Promise<void> {
    try {
      if (!this.client) throw new Error("Discord not connected");
      const channel = await this.client.channels.fetch(chatId);
      if (!channel?.isTextBased() || !("send" in channel)) throw new Error(`Cannot send to channel ${chatId}`);
      await channel.send({ files: [{ attachment: file.stream, name: file.filename }], allowedMentions: { parse: [] } });
    } finally {
      file.stream.destroy();
    }
  }

  /** Sends the one persistent per-turn status message — edited in place as tool calls/text stream in. */
  async sendAnchor(chatId: string): Promise<AnchorHandle> {
    if (!this.client) throw new Error("Discord not connected");

    const channel = await this.client.channels.fetch(chatId);
    if (!channel?.isTextBased() || !("send" in channel)) throw new Error(`Cannot send to channel ${chatId}`);

    const initial: AnchorState = { status: "running", toolCallCount: 0, currentStep: "" };
    const message = await channel.send({
      components: [buildAnchorContainer(initial)],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    });
    return {
      messageId: message.id,
      edit: async (state: AnchorState) => {
        await message.edit({
          components: [buildAnchorContainer(state)],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: { parse: [] },
        });
      },
    };
  }

  /** Starts a thread attached to the anchor message so it's visible as "N replies" — never orphaned. Returns null for channels that can't have threads (DMs, voice). */
  async createToolThread(chatId: string, anchorMessageId: string, name: string): Promise<string | null> {
    if (!this.client) throw new Error("Discord not connected");

    const channel = await this.client.channels.fetch(chatId);
    if (channel?.type !== ChannelType.GuildText && channel?.type !== ChannelType.GuildAnnouncement) return null;

    const truncated = name.length > 100 ? `${name.slice(0, 99)}…` : name;
    try {
      const thread = await channel.threads.create({
        name: truncated,
        startMessage: anchorMessageId,
        autoArchiveDuration: 1440,
      });
      return thread.id;
    } catch (err) {
      console.error("[discord] thread creation failed:", err);
      return null;
    }
  }

  /** Posts one batched, human-readable message of tool-call lines into a thread — never one message per call, never raw JSON. */
  async postThreadBatch(threadId: string, lines: string[]): Promise<void> {
    if (!this.client) throw new Error("Discord not connected");
    if (lines.length === 0) return;

    const channel = await this.client.channels.fetch(threadId);
    if (!channel?.isTextBased() || !("send" in channel)) throw new Error(`Cannot send to thread ${threadId}`);

    const fenceOverhead = 8; // "```\n" + "\n```"
    const raw = lines.join("\n");
    for (const chunk of chunkMessage(raw, DISCORD_MESSAGE_LIMIT - fenceOverhead)) {
      await channel.send({ content: `\`\`\`\n${chunk}\n\`\`\``, allowedMentions: { parse: [] } });
    }
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

  /** Registers /stop, /continue, /model against every guild the bot is currently in. Re-run on every connect — cheap, Discord dedups by name. */
  private async registerSlashCommands(): Promise<void> {
    if (!this.client) return;
    const commands = await buildSlashCommands();
    for (const guild of this.client.guilds.cache.values()) {
      try {
        await guild.commands.set(commands);
      } catch (err) {
        console.error(`[discord] slash command registration failed for guild ${guild.id}:`, err);
      }
    }
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isAutocomplete()) {
      await this.handleAutocomplete(interaction);
      return;
    }
    if (interaction.isChatInputCommand()) {
      await this.handleSlashCommand(interaction);
      return;
    }
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

  private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!this.slashCommandHandler) return;

    const chatId = interaction.channelId;
    const userId = interaction.user.id;
    const username = interaction.user.username;

    // Ack within Discord's ~3s window before anything else — checkAuthorization is normally
    // in-memory fast, but any delay here previously risked a 10062 "Unknown interaction".
    await interaction.deferReply();

    // Slash commands are guild-scoped registrations (never reachable from a DM) and an explicit,
    // deliberate invocation by the user — so isGroupChat/wasMentioned are always true here.
    const isAuthorized = await this.auth.checkAuthorization(
      userId,
      chatId,
      username,
      true,
      true,
      "discord",
      undefined,
      interaction.guildId ?? undefined
    );
    if (!isAuthorized) {
      await interaction.editReply("Not authorized to use commands in this channel.");
      return;
    }

    this.slashCommandHandler({
      commandName: interaction.commandName,
      subcommand: interaction.options.getSubcommand(false),
      channelId: chatId,
      userId,
      getStringOption: (name) => interaction.options.getString(name),
      reply: async (text: string) => {
        const [first, ...rest] = chunkMessage(text);
        await interaction.editReply(first);
        for (const chunk of rest) await interaction.followUp(chunk);
      },
    });
  }

  /** Autocomplete has its own hard 3s deadline with no defer — a slow/no handler just yields no suggestions. */
  private async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    if (!this.autocompleteHandler) {
      await interaction.respond([]).catch(() => {});
      return;
    }

    const focused = interaction.options.getFocused(true);
    this.autocompleteHandler({
      commandName: interaction.commandName,
      optionName: focused.name,
      value: String(focused.value),
      channelId: interaction.channelId,
      getStringOption: (name) => interaction.options.getString(name),
      respond: async (choices) => {
        await interaction.respond(choices.slice(0, 25)).catch(() => {});
      },
    });
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (VOICE_CHANNEL_TYPES.has(message.channel.type)) return;

    const content = message.content.trim();
    const attachments = [...message.attachments.values()].map((attachment) => ({
      id: attachment.id,
      name: attachment.name ?? "attachment",
      size: attachment.size,
      url: attachment.url,
    }));
    if (!content && attachments.length === 0) return;

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
      sendToChat,
      message.guildId ?? undefined
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
      attachments,
    });
  }
}
