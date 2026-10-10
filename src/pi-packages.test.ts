import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasPiPackage, isPiPackageInstalled, loadInstalledPiPackages } from "./pi-packages.js";

const writeSettings = async (packages: unknown): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "agent-daemon-pi-packages-"));
  const path = join(dir, "settings.json");
  await writeFile(path, JSON.stringify({ packages }));
  return path;
};

describe("loadInstalledPiPackages", () => {
  it("normalizes npm: and git: prefixed and scoped package specs to bare names", async () => {
    const path = await writeSettings([
      "npm:pi-invisible-continue",
      "npm:@zosmaai/pi-llm-wiki",
      "git:github.com/monotykamary/pi-invisible-continue",
    ]);

    const installed = await loadInstalledPiPackages(path);

    expect(installed).toEqual(new Set(["pi-invisible-continue", "pi-llm-wiki"]));
  });

  it("returns an empty set when settings.json is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-daemon-pi-packages-"));
    const installed = await loadInstalledPiPackages(join(dir, "missing.json"));
    expect(installed).toEqual(new Set());
  });

  it("returns an empty set when settings.json has no packages field", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-daemon-pi-packages-"));
    const path = join(dir, "settings.json");
    await writeFile(path, JSON.stringify({ theme: "matte-black" }));
    const installed = await loadInstalledPiPackages(path);
    expect(installed).toEqual(new Set());
  });

  it("returns an empty set for malformed JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-daemon-pi-packages-"));
    const path = join(dir, "settings.json");
    await writeFile(path, "{not json");
    const installed = await loadInstalledPiPackages(path);
    expect(installed).toEqual(new Set());
  });
});

describe("hasPiPackage", () => {
  it("checks membership by bare name", () => {
    const installed = new Set(["pi-invisible-continue"]);
    expect(hasPiPackage(installed, "pi-invisible-continue")).toBe(true);
    expect(hasPiPackage(installed, "pi-llm-wiki")).toBe(false);
  });
});

describe("isPiPackageInstalled", () => {
  it("reads settings.json and checks for the given package in one call", async () => {
    const path = await writeSettings(["npm:pi-invisible-continue"]);
    expect(await isPiPackageInstalled("pi-invisible-continue", path)).toBe(true);
    expect(await isPiPackageInstalled("pi-llm-wiki", path)).toBe(false);
  });
});
