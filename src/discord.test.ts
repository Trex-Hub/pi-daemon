import { ChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { GatewayAuth } from "./auth.js";
import { DiscordTransport } from "./discord.js";

const fakeInteraction = (overrides: Partial<Record<string, unknown>> = {}) => ({
  isAutocomplete: () => false,
  isChatInputCommand: () => true,
  commandName: "stop",
  channelId: "channel",
  guildId: "guild",
  user: { id: "user", username: "user" },
  options: { getSubcommand: () => null, getString: () => null },
  deferReply: vi.fn().mockResolvedValue(undefined),
  editReply: vi.fn().mockResolvedValue(undefined),
  followUp: vi.fn().mockResolvedValue(undefined),
  reply: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

const fakeButtonInteraction = (customId: string, overrides: Partial<Record<string, unknown>> = {}) => ({
  isAutocomplete: () => false,
  isChatInputCommand: () => false,
  isButton: () => true,
  customId,
  channel: { parent: { name: "cat" }, name: "chan" },
  deferUpdate: vi.fn().mockResolvedValue(undefined),
  editReply: vi.fn().mockResolvedValue(undefined),
  followUp: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

const fakeAutocomplete = (overrides: Partial<Record<string, unknown>> = {}) => ({
  isAutocomplete: () => true,
  commandName: "model",
  channelId: "channel",
  options: { getFocused: () => ({ name: "provider", value: "open" }), getString: () => null },
  respond: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

describe("DiscordTransport slash commands", () => {
  it("routes an authorized invocation to the handler with a working reply", async () => {
    const auth = { checkAuthorization: vi.fn().mockResolvedValue(true) } as unknown as GatewayAuth;
    const transport = new DiscordTransport("token", auth);
    const onSlashCommand = vi.fn();
    transport.onSlashCommand(onSlashCommand);

    const interaction = fakeInteraction();
    await (transport as any).handleInteraction(interaction);

    expect(auth.checkAuthorization).toHaveBeenCalledWith("user", "channel", "user", true, true, "discord", undefined, "guild");
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(onSlashCommand).toHaveBeenCalledWith(
      expect.objectContaining({ commandName: "stop", channelId: "channel", userId: "user" })
    );

    await onSlashCommand.mock.calls[0][0].reply("Stopped.");
    expect(interaction.editReply).toHaveBeenCalledWith("Stopped.");
  });

  it("rejects an unauthorized invocation without calling the handler", async () => {
    const auth = { checkAuthorization: vi.fn().mockResolvedValue(false) } as unknown as GatewayAuth;
    const transport = new DiscordTransport("token", auth);
    const onSlashCommand = vi.fn();
    transport.onSlashCommand(onSlashCommand);

    const interaction = fakeInteraction();
    await (transport as any).handleInteraction(interaction);

    expect(onSlashCommand).not.toHaveBeenCalled();
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("Not authorized"));
  });

  it("splits a reply over Discord's 2000-char limit into editReply + followUp", async () => {
    const auth = { checkAuthorization: vi.fn().mockResolvedValue(true) } as unknown as GatewayAuth;
    const transport = new DiscordTransport("token", auth);
    const onSlashCommand = vi.fn();
    transport.onSlashCommand(onSlashCommand);

    const interaction = fakeInteraction({ commandName: "model" });
    await (transport as any).handleInteraction(interaction);

    const longText = Array.from({ length: 300 }, (_, i) => `- provider/model-${i}`).join("\n");
    await onSlashCommand.mock.calls[0][0].reply(longText);

    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect((interaction.editReply as any).mock.calls[0][0].length).toBeLessThanOrEqual(2000);
    expect(interaction.followUp).toHaveBeenCalled();
  });
});

describe("DiscordTransport autocomplete", () => {
  it("routes a focused option to the handler and responds with capped choices", async () => {
    const auth = {} as unknown as GatewayAuth;
    const transport = new DiscordTransport("token", auth);
    const onAutocomplete = vi.fn((invocation) => {
      invocation.respond(Array.from({ length: 30 }, (_, i) => ({ name: `p${i}`, value: `p${i}` })));
    });
    transport.onAutocomplete(onAutocomplete);

    const interaction = fakeAutocomplete();
    await (transport as any).handleInteraction(interaction);

    expect(onAutocomplete).toHaveBeenCalledWith(
      expect.objectContaining({ commandName: "model", optionName: "provider", value: "open", channelId: "channel" })
    );
    expect(interaction.respond).toHaveBeenCalledWith(expect.arrayContaining([{ name: "p0", value: "p0" }]));
    expect((interaction.respond as any).mock.calls[0][0].length).toBe(25);
  });

  it("responds with an empty list when no handler is registered", async () => {
    const auth = {} as unknown as GatewayAuth;
    const transport = new DiscordTransport("token", auth);

    const interaction = fakeAutocomplete();
    await (transport as any).handleInteraction(interaction);

    expect(interaction.respond).toHaveBeenCalledWith([]);
  });
});

describe("DiscordTransport ask buttons", () => {
  it("routes an ask: customId to the ask-button handler, independent of the pi: namespace", async () => {
    const auth = {} as unknown as GatewayAuth;
    const transport = new DiscordTransport("token", auth);
    const onAskButton = vi.fn();
    const onButtonAction = vi.fn();
    transport.onAskButton(onAskButton);
    transport.onButtonAction(onButtonAction);

    const interaction = fakeButtonInteraction("ask:chan-1:uuid-1:yes");
    await (transport as any).handleInteraction(interaction);

    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(onAskButton).toHaveBeenCalledWith(expect.objectContaining({ channelId: "chan-1", id: "uuid-1", choice: "yes" }));
    expect(onButtonAction).not.toHaveBeenCalled();
  });

  it("respond() edits the original message in place and drops its buttons", async () => {
    const auth = {} as unknown as GatewayAuth;
    const transport = new DiscordTransport("token", auth);
    let captured: { respond(content: string): Promise<void> } | undefined;
    transport.onAskButton((action) => {
      captured = action;
    });

    const interaction = fakeButtonInteraction("ask:chan-1:uuid-1:no");
    await (transport as any).handleInteraction(interaction);
    await captured?.respond("Answered: no");

    expect(interaction.editReply).toHaveBeenCalledWith({ content: "Answered: no", components: [] });
  });

  it("leaves pi: namespace buttons routed to the existing button handler", async () => {
    const auth = {} as unknown as GatewayAuth;
    const transport = new DiscordTransport("token", auth);
    const onAskButton = vi.fn();
    const onButtonAction = vi.fn();
    transport.onAskButton(onAskButton);
    transport.onButtonAction(onButtonAction);

    const interaction = fakeButtonInteraction("pi:create:chan-1");
    await (transport as any).handleInteraction(interaction);

    expect(onButtonAction).toHaveBeenCalledWith(expect.objectContaining({ channelId: "chan-1", action: "create" }));
    expect(onAskButton).not.toHaveBeenCalled();
  });
});

describe("DiscordTransport attachment messages", () => {
  it("forwards an attachment-only message after authorization", async () => {
    const auth = {
      handleAdminCommand: vi.fn().mockResolvedValue(false),
      checkAuthorization: vi.fn().mockResolvedValue(true),
    } as unknown as GatewayAuth;
    const transport = new DiscordTransport("token", auth);
    const onMessage = vi.fn();
    transport.onMessage(onMessage);

    await (transport as any).handleMessage({
      author: { bot: false, id: "user", username: "user" },
      channel: { type: ChannelType.DM },
      channelId: "channel",
      content: "",
      attachments: new Map([
        ["file", { id: "file", name: "report.txt", size: 3, url: "https://cdn.discordapp.com/attachments/report.txt" }],
      ]),
      mentions: { users: { has: vi.fn().mockReturnValue(false) } },
      guildId: null,
      id: "message",
      createdAt: new Date(),
    });

    expect(auth.checkAuthorization).toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ content: "", attachments: [expect.objectContaining({ name: "report.txt" })] }));
  });
});
