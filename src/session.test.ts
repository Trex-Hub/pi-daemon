import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "./session.js";

function fakeProc(pid: number) {
  const emitter = new EventEmitter();
  return Object.assign(emitter, { pid, kill: vi.fn() }) as unknown as ChildProcess & {
    kill: ReturnType<typeof vi.fn>;
  };
}

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
});
