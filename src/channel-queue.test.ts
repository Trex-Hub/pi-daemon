import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { downloadAttachments } from "./attachments.js";
import { ChannelQueue } from "./channel-queue.js";

describe("ChannelQueue", () => {
  it("serializes work for one channel", async () => {
    const queue = new ChannelQueue(async () => {});
    const order: string[] = [];
    let release!: () => void;
    const first = queue.enqueue("channel", async () => {
      order.push("first-start");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push("first-end");
    });
    const second = queue.enqueue("channel", async () => {
      order.push("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("reports a failed download task without rejecting", async () => {
    const onError = vi.fn().mockResolvedValue(undefined);
    const queue = new ChannelQueue(onError);

    const dir = await mkdtemp(join(tmpdir(), "agent-daemon-queue-"));
    await expect(
      queue.enqueue("channel", async () => {
        await downloadAttachments(dir, [
          { id: "file", name: "report.txt", size: 1, url: "https://example.com/report.txt" },
        ]);
      })
    ).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledWith("channel", expect.any(Error));
    expect((onError.mock.calls[0][1] as Error).message).toContain("not hosted on Discord's CDN");
  });
});
