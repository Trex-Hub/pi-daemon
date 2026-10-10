import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./pi-packages.js", () => ({ isPiPackageInstalled: vi.fn() }));

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("buildSlashCommands", () => {
  it("includes /continue when pi-invisible-continue is installed", async () => {
    const { isPiPackageInstalled } = await import("./pi-packages.js");
    vi.mocked(isPiPackageInstalled).mockResolvedValue(true);
    const { buildSlashCommands } = await import("./commands.js");

    const commands = await buildSlashCommands();

    expect(commands.map((c) => c.name)).toEqual(["stop", "model", "continue"]);
  });

  it("omits /continue when pi-invisible-continue is not installed", async () => {
    const { isPiPackageInstalled } = await import("./pi-packages.js");
    vi.mocked(isPiPackageInstalled).mockResolvedValue(false);
    const { buildSlashCommands } = await import("./commands.js");

    const commands = await buildSlashCommands();

    expect(commands.map((c) => c.name)).toEqual(["stop", "model"]);
  });
});
