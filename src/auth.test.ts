import { describe, expect, it, vi } from "vitest";
import { GatewayAuth } from "./auth.js";
import type { GatewayState } from "./state.js";

function makeState(overrides?: Partial<GatewayState["auth"]>): GatewayState {
  return {
    config: { discordToken: "t", adminUserId: "admin1", projectsRoot: "/root", notifyOnCrash: true },
    routing: {},
    auth: { channelModes: {}, trustedUsers: [], ...overrides },
    ignoredChannels: [],
  };
}

function makeAuth(state: GatewayState) {
  return new GatewayAuth(
    state,
    () => {},
    () => {}
  );
}

describe("channel mode enforcement", () => {
  it("denies group message on unconfigured channel", async () => {
    const auth = makeAuth(makeState());
    const ok = await auth.checkAuthorization("u1", "chan1", "user", true, false, "discord");
    expect(ok).toBe(false);
  });

  it("allows anyone when mode is all", async () => {
    const state = makeState({ channelModes: { chan1: "all" } });
    const auth = makeAuth(state);
    expect(await auth.checkAuthorization("u1", "chan1", "user", true, false, "discord")).toBe(true);
  });

  it("mentions mode requires wasMentioned", async () => {
    const state = makeState({ channelModes: { chan1: "mentions" } });
    const auth = makeAuth(state);
    expect(await auth.checkAuthorization("u1", "chan1", "user", true, false, "discord")).toBe(false);
    expect(await auth.checkAuthorization("u1", "chan1", "user", true, true, "discord")).toBe(true);
  });

  it("trusted-only mode requires trusted user", async () => {
    const state = makeState({ channelModes: { chan1: "trusted-only" }, trustedUsers: ["discord:u1"] });
    const auth = makeAuth(state);
    expect(await auth.checkAuthorization("u2", "chan1", "user", true, false, "discord")).toBe(false);
    expect(await auth.checkAuthorization("u1", "chan1", "user", true, false, "discord")).toBe(true);
  });
});

describe("admin-only command gate", () => {
  it("blocks a trusted non-admin from /enable", async () => {
    const state = makeState({ trustedUsers: ["discord:u1"] });
    const auth = makeAuth(state);
    const sendMessage = vi.fn();
    await auth.handleAdminCommand("/enable chan1 all", "chan1", "u1", "discord", sendMessage);
    expect(sendMessage).toHaveBeenCalledWith("Only the admin can run this command.");
    expect(state.auth.channelModes.chan1).toBeUndefined();
  });

  it("allows the admin to run /enable", async () => {
    const state = makeState({ trustedUsers: ["discord:admin1"] });
    const auth = makeAuth(state);
    const sendMessage = vi.fn();
    await auth.handleAdminCommand("/enable chan1 all", "chan1", "admin1", "discord", sendMessage);
    expect(state.auth.channelModes.chan1).toBe("all");
  });

  it("lets any trusted user run non-admin commands like /help", async () => {
    const state = makeState({ trustedUsers: ["discord:u1"] });
    const auth = makeAuth(state);
    const sendMessage = vi.fn();
    const handled = await auth.handleAdminCommand("/help", "chan1", "u1", "discord", sendMessage);
    expect(handled).toBe(true);
    expect(sendMessage).not.toHaveBeenCalledWith("Only the admin can run this command.");
  });
});

describe("challenge-code flow", () => {
  it("issues a code on first DM and trusts the user once the code is entered", async () => {
    const state = makeState();
    let shownCode = "";
    const auth = new GatewayAuth(
      state,
      (code) => {
        shownCode = code;
      },
      () => {}
    );

    const first = await auth.checkAuthorization("u1", "dm1", "user", false, false, "discord");
    expect(first).toBe(false);
    expect(shownCode).toMatch(/^\d{6}$/);

    const sendMessage = vi.fn();
    const handled = await auth.handleAdminCommand(shownCode, "dm1", "u1", "discord", sendMessage);
    expect(handled).toBe(true);
    expect(state.auth.trustedUsers).toContain("discord:u1");
  });

  it("blocks the user after 3 wrong codes", async () => {
    const state = makeState();
    const auth = new GatewayAuth(
      state,
      () => {},
      () => {}
    );
    await auth.checkAuthorization("u1", "dm1", "user", false, false, "discord");

    const sendMessage = vi.fn();
    await auth.handleAdminCommand("000000", "dm1", "u1", "discord", sendMessage);
    await auth.handleAdminCommand("000000", "dm1", "u1", "discord", sendMessage);
    await auth.handleAdminCommand("000000", "dm1", "u1", "discord", sendMessage);

    expect(sendMessage).toHaveBeenLastCalledWith("Too many failed attempts. Blocked for 5 minutes.");

    const blockedResult = await auth.checkAuthorization("u1", "dm1", "user", false, false, "discord");
    expect(blockedResult).toBe(false);
  });
});
