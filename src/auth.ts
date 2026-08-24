import { randomInt } from "node:crypto";
import type { ChannelAuthMode, GatewayState, TrustedUserId } from "./state.js";

const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const BLOCK_DURATION_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;

interface ChallengeData {
  code: string;
  chatId: string;
  username: string;
  expiresAt: number;
  attempts: number;
}

export type SendMessage = (chatId: string, text: string) => Promise<void>;

// Commands that mutate auth state. Restricted to the single admin
// (config.adminUserId), not any trusted user — a trusted-only gate would let
// any trusted user grant channel-wide/guild-wide access to strangers via /enable.
const ADMIN_ONLY_COMMANDS = new Set(["/enable", "/disable", "/enable-guild", "/disable-guild", "/revoke"]);

/** Challenge-code onboarding + 3-tier channel auth against GatewayState. */
export class GatewayAuth {
  private challenges = new Map<TrustedUserId, ChallengeData>();
  private blockedUsers = new Map<TrustedUserId, number>();

  constructor(
    private state: GatewayState,
    private onShowCode: (code: string, username: string) => void,
    private onNotify: (message: string, level?: "info" | "warning" | "error") => void,
    private onSaveAuth?: () => void
  ) {}

  isTrusted(userId: TrustedUserId): boolean {
    return this.state.auth.trustedUsers.includes(userId);
  }

  isAdmin(userId: TrustedUserId): boolean {
    return userId === this.namespacedAdminId();
  }

  private namespacedAdminId(): TrustedUserId {
    return `discord:${this.state.config.adminUserId}`;
  }

  /** DM: challenge-gated. Group: channel mode wins if set, else falls back to the channel's guild mode. */
  async checkAuthorization(
    userId: string,
    chatId: string,
    username: string,
    isGroupChat: boolean,
    wasMentioned: boolean,
    transport: string,
    sendMessage?: SendMessage,
    guildId?: string
  ): Promise<boolean> {
    const namespacedUserId: TrustedUserId = `${transport}:${userId}`;

    const blockedUntil = this.blockedUsers.get(namespacedUserId);
    if (blockedUntil) {
      if (Date.now() < blockedUntil) return false;
      this.blockedUsers.delete(namespacedUserId);
    }

    if (!isGroupChat) {
      if (this.isTrusted(namespacedUserId)) return true;
      return this.initiateChallenge(namespacedUserId, chatId, username, sendMessage);
    }

    const mode = this.state.auth.channelModes[chatId] ?? (guildId ? this.state.auth.guildModes[guildId] : undefined);
    if (!mode) return false;
    return this.evaluateMode(mode, namespacedUserId, wasMentioned);
  }

  private evaluateMode(mode: ChannelAuthMode, namespacedUserId: TrustedUserId, wasMentioned: boolean): boolean {
    switch (mode) {
      case "all":
        return true;
      case "mentions":
        return wasMentioned;
      case "trusted-only":
        return this.isTrusted(namespacedUserId);
    }
  }

  private async initiateChallenge(
    userId: TrustedUserId,
    chatId: string,
    username: string,
    sendMessage?: SendMessage
  ): Promise<boolean> {
    const existing = this.challenges.get(userId);
    if (existing) {
      if (Date.now() > existing.expiresAt) {
        this.challenges.delete(userId);
      } else {
        return false;
      }
    }

    const code = this.generateCode();
    this.challenges.set(userId, {
      code,
      chatId,
      username,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
      attempts: 0,
    });

    this.onShowCode(code, username);
    if (sendMessage) {
      try {
        await sendMessage(chatId, "Please enter the 6-digit code provided by the bot admin. Expires in 2 minutes.");
      } catch {
        // ignore send errors
      }
    }
    return false;
  }

  /** DM-only. Handles challenge-code entry and admin slash commands. Returns true if handled. */
  async handleAdminCommand(
    text: string,
    _chatId: string,
    userId: string,
    transport: string,
    sendMessage: (text: string) => Promise<void>
  ): Promise<boolean> {
    const namespacedUserId: TrustedUserId = `${transport}:${userId}`;

    if (!this.isTrusted(namespacedUserId)) {
      const challenge = this.challenges.get(namespacedUserId);
      if (challenge && /^\d{6}$/.test(text)) {
        return this.validateChallenge(namespacedUserId, text, sendMessage);
      }
      return false;
    }

    const parts = text.split(/\s+/);
    const cmd = parts[0]?.toLowerCase();

    if (cmd && ADMIN_ONLY_COMMANDS.has(cmd) && !this.isAdmin(namespacedUserId)) {
      await sendMessage("Only the admin can run this command.");
      return true;
    }

    switch (cmd) {
      case "/help":
        await sendMessage(this.getHelpText());
        return true;

      case "/trusted": {
        const list = this.state.auth.trustedUsers.join(", ");
        await sendMessage(`Trusted users (${this.state.auth.trustedUsers.length}): ${list || "none"}`);
        return true;
      }

      case "/channels": {
        const entries = Object.entries(this.state.auth.channelModes);
        const list = entries.map(([id, mode]) => `- ${id}: ${mode}`).join("\n");
        await sendMessage(list || "No channels configured");
        return true;
      }

      case "/enable":
        if (parts.length < 3 || !isChannelAuthMode(parts[2])) {
          await sendMessage("Usage: /enable <channelId> <all|mentions|trusted-only>");
          return true;
        }
        this.state.auth.channelModes[parts[1]] = parts[2];
        this.onSaveAuth?.();
        await sendMessage(`Channel ${parts[1]} enabled (mode: ${parts[2]})`);
        this.onNotify(`Channel ${parts[1]} enabled (${parts[2]})`, "info");
        return true;

      case "/disable":
        if (parts.length < 2) {
          await sendMessage("Usage: /disable <channelId>");
          return true;
        }
        delete this.state.auth.channelModes[parts[1]];
        this.onSaveAuth?.();
        await sendMessage(`Channel ${parts[1]} disabled`);
        this.onNotify(`Channel ${parts[1]} disabled`, "info");
        return true;

      case "/guilds": {
        const entries = Object.entries(this.state.auth.guildModes);
        const list = entries.map(([id, mode]) => `- ${id}: ${mode}`).join("\n");
        await sendMessage(list || "No guilds configured");
        return true;
      }

      case "/enable-guild":
        if (parts.length < 3 || !isChannelAuthMode(parts[2])) {
          await sendMessage("Usage: /enable-guild <guildId> <all|mentions|trusted-only>");
          return true;
        }
        this.state.auth.guildModes[parts[1]] = parts[2];
        this.onSaveAuth?.();
        await sendMessage(`Guild ${parts[1]} enabled (mode: ${parts[2]})`);
        this.onNotify(`Guild ${parts[1]} enabled (${parts[2]})`, "info");
        return true;

      case "/disable-guild":
        if (parts.length < 2) {
          await sendMessage("Usage: /disable-guild <guildId>");
          return true;
        }
        delete this.state.auth.guildModes[parts[1]];
        this.onSaveAuth?.();
        await sendMessage(`Guild ${parts[1]} disabled`);
        this.onNotify(`Guild ${parts[1]} disabled`, "info");
        return true;

      case "/revoke": {
        if (parts.length < 2) {
          await sendMessage("Usage: /revoke <transport:userId>");
          return true;
        }
        const revokeId = parts[1];
        const idx = this.state.auth.trustedUsers.indexOf(revokeId);
        if (idx === -1) {
          await sendMessage(`User ${revokeId} not found in trusted users`);
          return true;
        }
        this.state.auth.trustedUsers.splice(idx, 1);
        this.onSaveAuth?.();
        await sendMessage(`Revoked trust for ${revokeId}`);
        this.onNotify(`Revoked: ${revokeId}`, "warning");
        return true;
      }

      default:
        return false;
    }
  }

  private async validateChallenge(
    userId: TrustedUserId,
    code: string,
    sendMessage: (text: string) => Promise<void>
  ): Promise<boolean> {
    const challenge = this.challenges.get(userId);
    if (!challenge) return false;

    if (Date.now() > challenge.expiresAt) {
      this.challenges.delete(userId);
      await sendMessage("Challenge expired. Send any message to get a new code.");
      return true;
    }

    if (code === challenge.code) {
      this.state.auth.trustedUsers.push(userId);
      this.challenges.delete(userId);
      this.onSaveAuth?.();
      await sendMessage("Authenticated. You can now chat with the agent.");
      this.onNotify(`${challenge.username} authenticated`, "info");
      return true;
    }

    challenge.attempts++;
    if (challenge.attempts >= MAX_ATTEMPTS) {
      this.challenges.delete(userId);
      this.blockedUsers.set(userId, Date.now() + BLOCK_DURATION_MS);
      await sendMessage("Too many failed attempts. Blocked for 5 minutes.");
      this.onNotify(`${challenge.username} blocked (3 failed attempts)`, "warning");
      return true;
    }

    await sendMessage(`Wrong code. ${MAX_ATTEMPTS - challenge.attempts} attempts remaining.`);
    return true;
  }

  private generateCode(): string {
    return randomInt(100000, 1000000).toString();
  }

  private getHelpText(): string {
    return `**Admin Commands**

*Any trusted user (DM only):*
- \`/help\` — Show this help
- \`/trusted\` — List trusted users
- \`/channels\` — List enabled channels
- \`/guilds\` — List enabled guilds (whole-server defaults)

*Admin only:*
- \`/enable <channelId> <all|mentions|trusted-only>\` — Enable a channel
- \`/disable <channelId>\` — Disable a channel
- \`/enable-guild <guildId> <all|mentions|trusted-only>\` — Enable an entire server; a channel rule always wins over the guild rule
- \`/disable-guild <guildId>\` — Disable a guild
- \`/revoke <transport:userId>\` — Revoke trust for a user

*Authentication:*
- First DM to bot → 6-digit code shown in terminal
- Enter code in chat → become trusted`;
  }
}

function isChannelAuthMode(value: string): value is ChannelAuthMode {
  return value === "all" || value === "mentions" || value === "trusted-only";
}
