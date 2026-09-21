import { ChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { GatewayAuth } from "./auth.js";
import { DiscordTransport } from "./discord.js";

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
