import { existsSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import type { CxAttachment, ResolvedCxAttachment } from "./types.ts";

const MIME: Readonly<Record<string, string>> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const MAX_BYTES = 10 * 1024 * 1024;
export class AttachmentError extends Error { public constructor(message: string) { super(message); this.name = "AttachmentError"; } }
export function validateAttachments(attachments: readonly CxAttachment[] | undefined, cwd: string): ResolvedCxAttachment[] {
  if (!attachments?.length) return [];
  return attachments.map((attachment) => {
    if (attachment.type !== "image" || Boolean(attachment.path) === Boolean(attachment.url)) throw new AttachmentError("An image attachment requires exactly one path or URL.");
    if (attachment.url) { if (!/^https:\/\//i.test(attachment.url)) throw new AttachmentError("Image URLs must use HTTPS."); return { type: "image", name: attachment.name ?? "remote-image", mimeType: attachment.mimeType ?? "image/*", url: attachment.url, ...(attachment.detail ? { detail: attachment.detail } : {}) }; }
    const path = resolve(cwd, attachment.path!); const rel = relative(resolve(cwd), path); const ext = extname(path).toLowerCase();
    const fileName = basename(path);
    const pathParts = path.split(/[\\/]+/);
    const sensitive = /(^\.env(?:\.|$)|\.(?:pem|key)$|(?:secrets?|credentials?))/i.test(fileName)
      || pathParts.some((part) => /^(?:\.env|secrets?|credentials?)$/i.test(part));
    if (isAbsolute(rel) || rel.startsWith("..") || sensitive) throw new AttachmentError("Image path is outside the workspace or sensitive.");
    if (!MIME[ext]) throw new AttachmentError("Unsupported image format. Use PNG, JPEG, WebP, or GIF.");
    if (!existsSync(path) || !statSync(path).isFile()) throw new AttachmentError("Image file does not exist.");
    if (statSync(path).size > MAX_BYTES) throw new AttachmentError("Image file exceeds the 10 MB limit.");
    return { type: "image", name: attachment.name ?? basename(path), mimeType: attachment.mimeType ?? MIME[ext]!, path, ...(attachment.detail ? { detail: attachment.detail } : {}) };
  });
}
export function attachmentInputs(attachments: readonly ResolvedCxAttachment[]): Array<Record<string, unknown>> { return attachments.map((attachment) => attachment.path ? { type: "localImage", path: attachment.path, ...(attachment.detail ? { detail: attachment.detail } : {}) } : { type: "image", url: attachment.url!, ...(attachment.detail ? { detail: attachment.detail } : {}) }); }
