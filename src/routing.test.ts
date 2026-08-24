import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveChannelDirectory } from "./routing.js";
import type { GatewayConfig, RoutingEntry } from "./state.js";

const config: GatewayConfig = {
  discordToken: "t",
  adminUserId: "a",
  projectsRoot: "/root/projects",
  notifyOnCrash: true,
};

describe("resolveChannelDirectory", () => {
  it("nests under category", () => {
    const routing: Record<string, RoutingEntry> = {};
    const dir = resolveChannelDirectory(config, routing, "c1", "work", "general");
    expect(dir).toBe(join("/root/projects", "work", "general"));
  });

  it("falls back to ungrouped when category is null", () => {
    const routing: Record<string, RoutingEntry> = {};
    const dir = resolveChannelDirectory(config, routing, "c1", null, "general");
    expect(dir).toBe(join("/root/projects", "ungrouped", "general"));
  });

  it("caches resolution by channelId, ignoring later renames", () => {
    const routing: Record<string, RoutingEntry> = {};
    const first = resolveChannelDirectory(config, routing, "c1", "work", "general");
    const second = resolveChannelDirectory(config, routing, "c1", "other", "renamed");
    expect(second).toBe(first);
  });

  it("sanitizes path-traversal attempts in category/channel names", () => {
    const routing: Record<string, RoutingEntry> = {};
    const dir = resolveChannelDirectory(config, routing, "c1", "../../etc", "../../passwd");
    expect(dir.startsWith(`${join("/root/projects")}/`)).toBe(true);
    expect(dir).not.toContain("../");
  });
});
