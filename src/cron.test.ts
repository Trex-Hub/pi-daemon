import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CronScheduler } from "./cron.js";
import { loadCronJobs } from "./cron-config.js";

function fakeProc() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  }) as unknown as ChildProcess & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
}

const job = { id: "j1", cron: "* * * * *", prompt: "do thing", dir: "/tmp" };

describe("CronScheduler.runJob", () => {
  it("resolves ok:true with captured stdout on a clean exit", async () => {
    const proc = fakeProc();
    const scheduler = new CronScheduler({ jobs: [], onJobResult: () => {}, spawnFn: () => proc });

    const resultPromise = scheduler.runJob(job);
    proc.stdout.emit("data", Buffer.from("hello "));
    proc.stdout.emit("data", Buffer.from("world"));
    proc.emit("exit", 0);

    expect(await resultPromise).toEqual({ id: "j1", ok: true, output: "hello world", deliverTo: undefined });
  });

  it("resolves ok:false with stderr captured on a non-zero exit", async () => {
    const proc = fakeProc();
    const scheduler = new CronScheduler({ jobs: [], onJobResult: () => {}, spawnFn: () => proc });

    const resultPromise = scheduler.runJob(job);
    proc.stderr.emit("data", Buffer.from("boom"));
    proc.emit("exit", 1);

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    expect(result.output).toContain("boom");
  });

  it("passes deliverTo through untouched", async () => {
    const proc = fakeProc();
    const scheduler = new CronScheduler({ jobs: [], onJobResult: () => {}, spawnFn: () => proc });

    const resultPromise = scheduler.runJob({ ...job, deliverTo: "discord:12345" });
    proc.emit("exit", 0);

    expect((await resultPromise).deliverTo).toBe("discord:12345");
  });

  it("does not spawn a second run while one is in flight (overlap guard, via fire)", () => {
    let calls = 0;
    const procs: ReturnType<typeof fakeProc>[] = [];
    const scheduler = new CronScheduler({
      jobs: [],
      onJobResult: () => {},
      spawnFn: () => {
        calls++;
        const p = fakeProc();
        procs.push(p);
        return p;
      },
    });

    const schedulerAny = scheduler as unknown as { fire(j: typeof job): void };
    schedulerAny.fire(job);
    schedulerAny.fire(job);

    expect(calls).toBe(1);
    procs[0].emit("exit", 0);
  });
});

describe("loadCronJobs", () => {
  it("returns [] when the file does not exist", async () => {
    expect(await loadCronJobs(join(tmpdir(), "does-not-exist-cron-jobs.json"))).toEqual([]);
  });

  it("skips a malformed job while keeping valid siblings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cron-config-test-"));
    const path = join(dir, "cron-jobs.json");
    try {
      await writeFile(
        path,
        JSON.stringify({
          jobs: [
            { id: "bad", cron: "not a cron expr", prompt: "p", dir: "/tmp" },
            { id: "good", cron: "* * * * *", prompt: "p", dir: "/tmp" },
          ],
        })
      );
      const jobs = await loadCronJobs(path);
      expect(jobs.map((j) => j.id)).toEqual(["good"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips a job with a duplicate id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cron-config-test-"));
    const path = join(dir, "cron-jobs.json");
    try {
      await writeFile(
        path,
        JSON.stringify({
          jobs: [
            { id: "dup", cron: "* * * * *", prompt: "p", dir: "/tmp" },
            { id: "dup", cron: "* * * * *", prompt: "p2", dir: "/tmp" },
          ],
        })
      );
      const jobs = await loadCronJobs(path);
      expect(jobs).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
