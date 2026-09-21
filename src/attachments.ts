import { type ReadStream } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

export const MAX_ATTACHMENT_COUNT = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 30_000;
const DISCORD_CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

export type AttachmentInput = {
  id: string;
  name: string;
  size: number;
  url: string;
};

export type OutboundFile = {
  filename: string;
  stream: ReadStream;
};

export class AttachmentError extends Error {}

const isInside = (root: string, path: string): boolean => path === root || path.startsWith(root + sep);

const safeName = (name: string): string => {
  const cleaned = basename(name).replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 100);
  return cleaned || "attachment";
};

const safeId = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, "_") || "attachment";

export const isDiscordCdnUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && DISCORD_CDN_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
};

const ensureUploadDirectory = async (dir: string): Promise<string> => {
  const root = resolve(dir);
  const uploadDir = resolve(root, "uploads");
  if (!isInside(root, uploadDir)) throw new AttachmentError("Invalid upload directory");
  await mkdir(uploadDir, { recursive: true });
  return uploadDir;
};

const validateAttachments = (attachments: AttachmentInput[]): void => {
  if (attachments.length > MAX_ATTACHMENT_COUNT) {
    throw new AttachmentError(`Too many attachments (maximum ${MAX_ATTACHMENT_COUNT})`);
  }

  let total = 0;
  for (const attachment of attachments) {
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentError(`${attachment.name} exceeds the 10 MiB file limit`);
    }
    total += attachment.size;
    if (total > MAX_ATTACHMENT_BYTES) throw new AttachmentError("Attachments exceed the 10 MiB total limit");
    if (!isDiscordCdnUrl(attachment.url)) throw new AttachmentError(`${attachment.name} is not hosted on Discord's CDN`);
  }
};

const downloadFile = async (
  attachment: AttachmentInput,
  target: string,
  addBytes: (bytes: number) => void,
  onCreated: () => void
): Promise<void> => {
  let response: Response;
  try {
    response = await fetch(attachment.url, { redirect: "error", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch {
    throw new AttachmentError(`Could not download ${attachment.name}`);
  }

  if (!response.ok || !response.body || response.redirected) throw new AttachmentError(`Could not download ${attachment.name}`);
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError(`${attachment.name} exceeds the 10 MiB file limit`);
  }

  const file = await open(target, "wx");
  onCreated();
  let bytes = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_ATTACHMENT_BYTES) throw new AttachmentError(`${attachment.name} exceeds the 10 MiB file limit`);
      addBytes(value.byteLength);
      await file.write(value);
    }
  } catch (err) {
    if (err instanceof AttachmentError) throw err;
    throw new AttachmentError(`Could not download ${attachment.name}`);
  } finally {
    await file.close();
  }
};

export const downloadAttachments = async (dir: string, attachments: AttachmentInput[]): Promise<string[]> => {
  validateAttachments(attachments);
  if (attachments.length === 0) return [];

  const uploadDir = await ensureUploadDirectory(dir);
  const created: string[] = [];
  let total = 0;
  try {
    const paths: string[] = [];
    for (const attachment of attachments) {
      const target = resolve(uploadDir, `${safeId(attachment.id)}-${safeName(attachment.name)}`);
      if (!isInside(uploadDir, target)) throw new AttachmentError("Invalid attachment filename");
      await downloadFile(
        attachment,
        target,
        (bytes) => {
          total += bytes;
          if (total > MAX_ATTACHMENT_BYTES) throw new AttachmentError("Attachments exceed the 10 MiB total limit");
        },
        () => created.push(target)
      );
      paths.push(relative(dir, target));
    }
    return paths;
  } catch (err) {
    await Promise.all(created.map((path) => rm(path, { force: true })));
    throw err;
  }
};

export const resolveOutboundFile = async (dir: string, requestedPath: string): Promise<OutboundFile> => {
  const segments = requestedPath.split(/[\\/]/);
  if (!requestedPath || isAbsolute(requestedPath) || segments.some((segment) => segment.startsWith("."))) {
    throw new AttachmentError("Requested file path is not allowed");
  }

  const root = await realpath(dir);
  const candidate = resolve(root, requestedPath);
  if (!isInside(root, candidate)) throw new AttachmentError("Requested file is outside the project directory");
  const candidateInfo = await lstat(candidate);
  if (!candidateInfo.isFile() || candidateInfo.isSymbolicLink()) throw new AttachmentError("Requested path is not a regular file");

  const resolved = await realpath(candidate);
  if (!isInside(root, resolved)) throw new AttachmentError("Requested file is outside the project directory");

  const file = await open(resolved, "r");
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new AttachmentError("Requested path is not a regular file");
    if (info.size > MAX_ATTACHMENT_BYTES) throw new AttachmentError("Requested file exceeds the 10 MiB limit");
    return { filename: basename(resolved), stream: file.createReadStream({ end: MAX_ATTACHMENT_BYTES - 1 }) };
  } catch (err) {
    await file.close();
    throw err;
  }
};
