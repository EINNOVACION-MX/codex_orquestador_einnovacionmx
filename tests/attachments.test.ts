import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachmentInputs, AttachmentError, validateAttachments } from "../src/attachments.ts";
import { routeTask } from "../src/router.ts";

function workspace() { const cwd = mkdtempSync(join(tmpdir(), "cx-image-")); writeFileSync(join(cwd, "one.png"), "png"); writeFileSync(join(cwd, "two.jpg"), "jpg"); writeFileSync(join(cwd, ".env.png"), "secret"); return cwd; }
describe("CX attachments", () => {
  it("validates one or multiple local images and produces App Server inputs", () => { const cwd = workspace(); const images = validateAttachments([{ type: "image", path: "one.png" }, { type: "image", path: "two.jpg" }], cwd); assert.equal(images.length, 2); assert.deepEqual(attachmentInputs(images).map((item) => item.type), ["localImage", "localImage"]); });
  it("supports HTTPS image URLs without serializing bytes", () => { const images = validateAttachments([{ type: "image", url: "https://example.com/reference.png", name: "reference.png" }], workspace()); assert.equal(attachmentInputs(images)[0]?.type, "image"); assert.equal(images[0]?.name, "reference.png"); });
  it("rejects missing, invalid, and secret-like image paths", () => { const cwd = workspace(); assert.throws(() => validateAttachments([{ type: "image", path: "missing.png" }], cwd), AttachmentError); writeFileSync(join(cwd, "note.txt"), "x"); assert.throws(() => validateAttachments([{ type: "image", path: "note.txt" }], cwd), /Unsupported/); assert.throws(() => validateAttachments([{ type: "image", path: ".env.png" }], cwd), /sensitive/); });
  it("rejects non-HTTPS, outside-workspace, and oversized inputs", () => { const cwd = workspace(); assert.throws(() => validateAttachments([{ type: "image", url: "http://example.com/a.png" }], cwd), /HTTPS/); assert.throws(() => validateAttachments([{ type: "image", path: "../outside.png" }], cwd), /outside/); writeFileSync(join(cwd, "large.png"), Buffer.alloc(10 * 1024 * 1024 + 1)); assert.throws(() => validateAttachments([{ type: "image", path: "large.png" }], cwd), /10 MB/); });
  it("marks visual context without escalating model selection by itself", () => { const result = routeTask({ prompt: "Cambia el color del login", hasVisualContext: true }); assert.equal(result.hasVisualContext, true); assert.equal(result.selectedModel, "luna"); });
});
