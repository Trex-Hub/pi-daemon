import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultState, loadState, migrateState } from "./state.js";

describe("loadState", () => {
  it("merges missing fields from defaults but never writes to disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-daemon-state-test-"));
    const path = join(dir, "state.json");
    const { allowedChannels: _omit, ...oldConfig } = defaultState().config;
    const raw = JSON.stringify({ ...defaultState(), config: oldConfig });
    await writeFile(path, raw);

    const state = await loadState(path);
    expect(state.config.allowedChannels).toEqual(["*"]);

    expect(await readFile(path, "utf8")).toBe(raw);
  });
});

describe("migrateState", () => {
  it("backfills missing fields into an old state.json and persists them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-daemon-state-test-"));
    const path = join(dir, "state.json");
    // simulate a pre-0.4.0 file saved before allowedChannels existed
    const { allowedChannels: _omit, ...oldConfig } = defaultState().config;
    await writeFile(path, JSON.stringify({ ...defaultState(), config: oldConfig }));

    await migrateState(path);

    const onDisk = JSON.parse(await readFile(path, "utf8"));
    expect(onDisk.config.allowedChannels).toEqual(["*"]);
  });

  it("does not rewrite a file that already matches the merged defaults", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-daemon-state-test-"));
    const path = join(dir, "state.json");
    await writeFile(path, JSON.stringify(defaultState()));

    const before = await readFile(path, "utf8");
    await migrateState(path);
    const after = await readFile(path, "utf8");
    expect(after).toBe(before);
  });

  it("does nothing when no state.json exists yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-daemon-state-test-"));
    const path = join(dir, "state.json");
    await expect(migrateState(path)).resolves.toBeUndefined();
  });
});
