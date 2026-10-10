import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { buildPiArgs, COMMAND_TIMEOUT_MS, SessionManager } from "./session.js";

function fakeProc(pid: number) {
  const emitter = new EventEmitter();
  return Object.assign(emitter, { pid, kill: vi.fn() }) as unknown as ChildProcess & {
    kill: ReturnType<typeof vi.fn>;
  };
}

/** A fakeProc with a real stdout emitter (for RPC event delivery) and a stdin write spy. */
function fakeRpcProc(pid: number) {
  const proc = fakeProc(pid);
  const stdout = new EventEmitter();
  const stdin = { write: vi.fn() };
  return Object.assign(proc, { stdout, stdin }) as unknown as ChildProcess & {
    kill: ReturnType<typeof vi.fn>;
    stdout: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn> };
  };
}

const emitLine = (proc: { stdout: EventEmitter }, payload: unknown): void => {
  proc.stdout.emit("data", Buffer.from(`${JSON.stringify(payload)}\n`));
};

describe("buildPiArgs", () => {
  it("starts RPC mode with the Discord file marker convention appended", () => {
    expect(buildPiArgs()).toEqual([
      "--mode",
      "rpc",
      "--append-system-prompt",
      expect.stringContaining("[[discord-file:relative/path]]"),
    ]);
  });
});

describe("SessionManager", () => {
  it("spawns once per channel and reuses it on later gets", () => {
    let calls = 0;
    const manager = new SessionManager({
      notifyCrash: false,
      spawnFn: () => {
        calls++;
        return fakeProc(100 + calls);
      },
    });

    const first = manager.getOrCreate("c1", "/root/projects/work/general");
    const second = manager.getOrCreate("c1", "/root/projects/work/general");

    expect(second).toBe(first);
    expect(calls).toBe(1);
  });

  it("respawns silently after a crash, without notifying when disabled", () => {
    const procs: ReturnType<typeof fakeProc>[] = [];
    const onCrash = vi.fn();
    const manager = new SessionManager({
      notifyCrash: false,
      onCrash,
      spawnFn: () => {
        const p = fakeProc(200 + procs.length);
        procs.push(p);
        return p;
      },
    });

    const first = manager.getOrCreate("c1", "/dir");
    procs[0].emit("exit", 1, null);

    const second = manager.getOrCreate("c1", "/dir");

    expect(second).not.toBe(first);
    expect(onCrash).not.toHaveBeenCalled();
  });

  it("notifies on crash when enabled", () => {
    const procs: ReturnType<typeof fakeProc>[] = [];
    const onCrash = vi.fn();
    const manager = new SessionManager({
      notifyCrash: true,
      onCrash,
      spawnFn: () => {
        const p = fakeProc(300 + procs.length);
        procs.push(p);
        return p;
      },
    });

    manager.getOrCreate("c1", "/dir");
    procs[0].emit("exit", 1, null);

    expect(onCrash).toHaveBeenCalledWith("c1");
  });

  it("reaps sessions idle past the timeout", () => {
    const proc = fakeProc(400);
    const manager = new SessionManager({
      notifyCrash: false,
      idleTimeoutMs: 1000,
      spawnFn: () => proc,
    });

    const session = manager.getOrCreate("c1", "/dir");
    manager.reapIdle(session.lastActivity + 2000);

    expect(proc.kill).toHaveBeenCalled();

    const respawned = manager.getOrCreate("c1", "/dir");
    expect(respawned).not.toBe(session);
  });

  it("does not reap sessions touched within the timeout", () => {
    const proc = fakeProc(500);
    const manager = new SessionManager({
      notifyCrash: false,
      idleTimeoutMs: 1000,
      spawnFn: () => proc,
    });

    const session = manager.getOrCreate("c1", "/dir");
    manager.reapIdle(session.lastActivity + 500);

    expect(proc.kill).not.toHaveBeenCalled();
  });

  describe("RPC commands", () => {
    it("resolves with an error when the channel has no live session", async () => {
      const manager = new SessionManager({ notifyCrash: false, spawnFn: () => fakeProc(1) });
      await expect(manager.abort("nope")).resolves.toEqual({ success: false, error: "No active session for this channel" });
    });

    it("writes an id-tagged command and resolves on the matching response", async () => {
      const proc = fakeRpcProc(600);
      const manager = new SessionManager({ notifyCrash: false, spawnFn: () => proc });
      manager.getOrCreate("c1", "/dir");

      const pending = manager.abort("c1");
      const written = JSON.parse(proc.stdin.write.mock.calls[0][0] as string);
      expect(written).toEqual({ type: "abort", id: 0 });

      emitLine(proc, { id: 0, type: "response", success: true });
      await expect(pending).resolves.toEqual({ success: true, data: undefined, error: undefined });
    });

    it("setModel and getAvailableModels write the right command shape with incrementing ids", async () => {
      const proc = fakeRpcProc(601);
      const manager = new SessionManager({ notifyCrash: false, spawnFn: () => proc });
      manager.getOrCreate("c1", "/dir");

      const first = manager.setModel("c1", "anthropic", "claude-sonnet-5");
      const second = manager.getAvailableModels("c1");

      expect(JSON.parse(proc.stdin.write.mock.calls[0][0] as string)).toEqual({
        type: "set_model",
        provider: "anthropic",
        modelId: "claude-sonnet-5",
        id: 0,
      });
      expect(JSON.parse(proc.stdin.write.mock.calls[1][0] as string)).toEqual({ type: "get_available_models", id: 1 });

      emitLine(proc, { id: 0, type: "response", success: false, error: "Model not found" });
      emitLine(proc, { id: 1, type: "response", success: true, data: { models: [] } });
      await expect(first).resolves.toEqual({ success: false, data: undefined, error: "Model not found" });
      await expect(second).resolves.toEqual({ success: true, data: { models: [] }, error: undefined });
    });

    it("does not forward response events to onEvent, but forwards everything else", async () => {
      const proc = fakeRpcProc(602);
      const onEvent = vi.fn();
      const manager = new SessionManager({ notifyCrash: false, spawnFn: () => proc, onEvent });
      manager.getOrCreate("c1", "/dir");

      const pending = manager.abort("c1");
      emitLine(proc, { id: 0, type: "response", success: true });
      emitLine(proc, { type: "agent_settled" });

      await pending;
      expect(onEvent).toHaveBeenCalledTimes(1);
      expect(onEvent).toHaveBeenCalledWith("c1", { type: "agent_settled" });
    });

    it("settles pending commands with an error when the process exits before responding", async () => {
      const proc = fakeRpcProc(603);
      const manager = new SessionManager({ notifyCrash: false, spawnFn: () => proc });
      manager.getOrCreate("c1", "/dir");

      const pending = manager.abort("c1");
      proc.emit("exit", 1, null);

      await expect(pending).resolves.toEqual({ success: false, error: "Session process exited" });
    });

    it("times out a command that never gets a response", async () => {
      vi.useFakeTimers();
      try {
        const proc = fakeRpcProc(604);
        const manager = new SessionManager({ notifyCrash: false, spawnFn: () => proc });
        manager.getOrCreate("c1", "/dir");

        const pending = manager.abort("c1");
        await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS);

        await expect(pending).resolves.toEqual({ success: false, error: "Command timed out" });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
