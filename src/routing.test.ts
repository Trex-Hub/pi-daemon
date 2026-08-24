import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { candidateDirectory, lookupChannelDirectory, mapChannel } from "./routing.js";
import type { GatewayConfig, RoutingEntry } from "./state.js";

const config: GatewayConfig = {
  discordToken: "t",
  adminUserId: "a",
  projectsRoot: "/root/projects",
  notifyOnCrash: true,
};

describe("candidateDirectory", () => {
  it("nests under category", () => {
    expect(candidateDirectory(config, "work", "general")).toBe(join("/root/projects", "work", "general"));
  });

  it("falls back to ungrouped when category is null", () => {
    expect(candidateDirectory(config, null, "general")).toBe(join("/root/projects", "ungrouped", "general"));
  });

  it("sanitizes path-traversal attempts in category/channel names", () => {
    const dir = candidateDirectory(config, "../../etc", "../../passwd");
    expect(dir.startsWith(`${join("/root/projects")}/`)).toBe(true);
    expect(dir).not.toContain("../");
  });
});

describe("lookupChannelDirectory + mapChannel", () => {
  it("is unmapped until mapChannel persists it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-gateway-test-"));
    const liveConfig: GatewayConfig = { ...config, projectsRoot: root };
    const routing: Record<string, RoutingEntry> = {};

    expect(lookupChannelDirectory(routing, "c1")).toBeNull();

    const dir = await mapChannel(liveConfig, routing, "c1", "work", "general");

    expect(dir).toBe(join(root, "work", "general"));
    expect(lookupChannelDirectory(routing, "c1")).toBe(dir);
  });
});
