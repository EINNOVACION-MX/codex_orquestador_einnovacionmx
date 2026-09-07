import { createInterface } from "node:readline";
import { CodexAdapter } from "../codex/adapter.ts";
import { CxNativeBridge, CxBridgeError } from "../bridge/cx-native-bridge.ts";

type RpcRequest = { jsonrpc?: string; id?: number | string; method?: string; params?: unknown };
const send = (id: RpcRequest["id"], result?: unknown, error?: { code: number; message: string }) => process.stdout.write(`${JSON.stringify(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result })}\n`);
const tool = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) => ({ name, description, inputSchema: { type: "object", properties, required } });
const tools = [
  tool("cx_route", "Classify a task and return CX model, reasoning, usage and budget. Does not execute. Image paths must be inside this workspace; image URLs must use HTTPS.", { task: { type: "string" }, images: { type: "array", items: { type: "object", properties: { path: { type: "string" }, url: { type: "string" }, name: { type: "string" } } } } }, ["task"]),
  tool("cx_execute", "Execute a task through the CX AutoModelOrchestrator for this workspace. Native chat attachments are not passed automatically; provide accessible image paths or HTTPS URLs explicitly.", { task: { type: "string" }, images: { type: "array", items: { type: "object", properties: { path: { type: "string" }, url: { type: "string" }, name: { type: "string" } } } } }, ["task"]),
  tool("cx_status", "Return Codex usage and derived budget. Never starts a turn."),
  tool("cx_project", "Return safe metadata for the current CX project."),
  tool("cx_context", "Return the compact, secret-free CX project context envelope."),
];
async function main() {
  const adapter = await CodexAdapter.connect(); const bridge = new CxNativeBridge({ cwd: process.cwd(), adapter });
  const close = async () => { await adapter.close(); };
  process.once("SIGINT", () => void close()); process.once("SIGTERM", () => void close());
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", async (line) => {
    let request: RpcRequest; try { request = JSON.parse(line) as RpcRequest; } catch { return; }
    if (request.id === undefined) return;
    try {
      if (request.method === "initialize") send(request.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "cx-bridge", version: "0.1.0" } });
      else if (request.method === "tools/list") send(request.id, { tools });
      else if (request.method === "tools/call") { const params = request.params as { name?: string; arguments?: { task?: string; images?: Array<{ path?: string; url?: string; name?: string }> } }; const task = params.arguments?.task ?? ""; const images = params.arguments?.images?.map((image) => ({ type: "image" as const, ...image })); const value = params.name === "cx_route" ? await bridge.route(task, images) : params.name === "cx_execute" ? await bridge.execute(task, images) : params.name === "cx_status" ? await bridge.status() : params.name === "cx_project" ? bridge.project() : params.name === "cx_context" ? bridge.context() : (() => { throw new CxBridgeError("Unknown CX tool."); })(); send(request.id, { content: [{ type: "text", text: JSON.stringify(value) }] }); }
      else send(request.id, undefined, { code: -32601, message: "Method not found" });
    } catch (error) { send(request.id, undefined, { code: -32000, message: error instanceof Error ? error.message : "CX bridge failed" }); }
  });
}
void main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : "CX bridge startup failed"}\n`); process.exitCode = 1; });
