import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentError, downloadAttachments, MAX_ATTACHMENT_BYTES, resolveOutboundFile } from "./attachments.js";

const cdnAttachment = (overrides: Partial<{ id: string; name: string; size: number; url: string }> = {}) => ({
  id: "attachment-1",
  name: "report.txt",
  size: 3,
  url: "https://cdn.discordapp.com/attachments/report.txt",
  ...overrides,
});

const mockFetch = (response: Response): ReturnType<typeof vi.fn> => {
  const fetch = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetch);
  return fetch;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("downloadAttachments", () => {
  it("writes safe paths and ignores hostile filenames", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-daemon-attachment-"));
    mockFetch(new Response("ok"));

    const paths = await downloadAttachments(dir, [cdnAttachment({ name: "../../report.txt", size: 2 })]);

    expect(paths).toEqual(["uploads/attachment-1-report.txt"]);
    expect(await readFile(join(dir, paths[0]), "utf8")).toBe("ok");
  });

  it("uses attachment IDs to keep same-named files distinct", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-daemon-attachment-"));
    const fetch = vi.fn().mockResolvedValueOnce(new Response("a")).mockResolvedValueOnce(new Response("b"));
    vi.stubGlobal("fetch", fetch);

    const paths = await downloadAttachments(dir, [
      cdnAttachment({ id: "first", name: "report.txt", size: 1 }),
      cdnAttachment({ id: "second", name: "report.txt", size: 1 }),
    ]);

    expect(paths).toEqual(["uploads/first-report.txt", "uploads/second-report.txt"]);
  });

  it("keeps earlier uploads when a later download fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-daemon-attachment-"));
    await mkdir(join(dir, "uploads"));
    await writeFile(join(dir, "uploads", "earlier.txt"), "keep");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_ATTACHMENT_BYTES + 1));
        controller.close();
      },
    });
    mockFetch(new Response(body));

    await expect(downloadAttachments(dir, [cdnAttachment({ id: "partial", size: 1 })])).rejects.toThrow("exceeds the 10 MiB");
    expect(await readFile(join(dir, "uploads", "earlier.txt"), "utf8")).toBe("keep");
    await expect(readFile(join(dir, "uploads", "partial-report.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects more than five attachments before fetching", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const dir = await mkdtemp(join(tmpdir(), "agent-daemon-attachment-"));
    const attachments = Array.from({ length: 6 }, (_, i) => cdnAttachment({ id: `${i}` }));

    await expect(downloadAttachments(dir, attachments)).rejects.toThrow("Too many attachments");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects declared files over the per-file limit before fetching", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const dir = await mkdtemp(join(tmpdir(), "agent-daemon-attachment-"));

    await expect(downloadAttachments(dir, [cdnAttachment({ size: MAX_ATTACHMENT_BYTES + 1 })])).rejects.toThrow(
      "exceeds the 10 MiB file limit"
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects declared files over the total limit before fetching", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const dir = await mkdtemp(join(tmpdir(), "agent-daemon-attachment-"));

    await expect(
      downloadAttachments(dir, [
        cdnAttachment({ id: "first", size: 6 * 1024 * 1024 }),
        cdnAttachment({ id: "second", size: 6 * 1024 * 1024 }),
      ])
    ).rejects.toThrow("exceed the 10 MiB total limit");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a content-length over the cap before reading the body", async () => {
    const fetch = mockFetch(new Response("ok", { headers: { "content-length": String(MAX_ATTACHMENT_BYTES + 1) } }));
    const dir = await mkdtemp(join(tmpdir(), "agent-daemon-attachment-"));

    await expect(downloadAttachments(dir, [cdnAttachment({ size: 1 })])).rejects.toThrow("exceeds the 10 MiB file limit");
    expect(fetch).toHaveBeenCalled();
  });

  it("rejects a non-CDN URL before fetching", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const dir = await mkdtemp(join(tmpdir(), "agent-daemon-attachment-"));

    await expect(downloadAttachments(dir, [cdnAttachment({ url: "https://example.com/file" })])).rejects.toThrow(AttachmentError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses redirects", async () => {
    const response = new Response("ok");
    Object.defineProperty(response, "redirected", { value: true });
    const fetch = mockFetch(response);
    const dir = await mkdtemp(join(tmpdir(), "agent-daemon-attachment-"));

    await expect(downloadAttachments(dir, [cdnAttachment({ size: 2 })])).rejects.toThrow("Could not download");
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: "error" }));
  });
});

describe("resolveOutboundFile", () => {
  it("rejects dot-segments", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-daemon-outbound-"));
    await writeFile(join(dir, ".env"), "secret");

    await expect(resolveOutboundFile(dir, ".env")).rejects.toThrow("not allowed");
  });

  it("rejects a symlinked file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-daemon-outbound-"));
    await writeFile(join(dir, "report.txt"), "report");
    await symlink(join(dir, "report.txt"), join(dir, "linked.txt"));

    await expect(resolveOutboundFile(dir, "linked.txt")).rejects.toThrow("not a regular file");
  });

  it("rejects a file through a symlinked directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-daemon-outbound-"));
    const outside = await mkdtemp(join(tmpdir(), "agent-daemon-outside-"));
    await writeFile(join(outside, "report.txt"), "report");
    await symlink(outside, join(dir, "linked-dir"));

    await expect(resolveOutboundFile(dir, "linked-dir/report.txt")).rejects.toThrow("outside the project directory");
  });

  it("rejects files over the outbound cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-daemon-outbound-"));
    await writeFile(join(dir, "large.bin"), Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));

    await expect(resolveOutboundFile(dir, "large.bin")).rejects.toThrow("exceeds the 10 MiB limit");
  });

  it("opens a capped stream from the resolved regular file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-daemon-outbound-"));
    await writeFile(join(dir, "report.txt"), "report");

    const file = await resolveOutboundFile(dir, "report.txt");
    expect(file.filename).toBe("report.txt");
    const chunks: Buffer[] = [];
    for await (const chunk of file.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("report");
  });
});
