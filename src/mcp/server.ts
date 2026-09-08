import { createInterface } from "node:readline";
import { CodexAdapter } from "../codex/adapter.ts";
import { CxNativeBridge, CxBridgeError } from "../bridge/cx-native-bridge.ts";
import { mcpTools } from "./tools.ts";

type RpcRequest = { jsonrpc?: string; id?: number | string; method?: string; params?: unknown };
const send = (id: RpcRequest["id"], result?: unknown, error?: { code: number; message: string }) => process.stdout.write(`${JSON.stringify(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result })}\n`);
async function main() {
  const adapter = await CodexAdapter.connect(); const bridge = new CxNativeBridge({ cwd: process.cwd(), adapter });
  const close = async () => { await adapter.close(); };
  process.once("SIGINT", () => void close()); process.once("SIGTERM", () => void close());
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", async (line) => {
    let request: RpcRequest; try { request = JSON.parse(line) as RpcRequest; } catch { return; }
    if (request.id === undefined) return;
    try {
      if (request.method === "initialize") send(request.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "cx-bridge", version: "0.3.0" } });
      else if (request.method === "tools/list") send(request.id, { tools: mcpTools });
      else if (request.method === "tools/call") { const params = request.params as { name?: string; arguments?: { task?: string; images?: Array<{ path?: string; url?: string; name?: string }> } }; const task = params.arguments?.task ?? ""; const images = params.arguments?.images?.map((image) => ({ type: "image" as const, ...image })); const value = params.name === "cx_route" ? await bridge.route(task, images) : params.name === "cx_execute" ? await bridge.execute(task, images) : params.name === "cx_status" ? await bridge.status() : params.name === "cx_project" ? bridge.project() : params.name === "cx_context" ? bridge.context() : params.name === "cx_capabilities" ? await bridge.capabilities() : params.name === "cx_agents" ? bridge.agents() : (() => { throw new CxBridgeError("Unknown CX tool."); })(); send(request.id, { content: [{ type: "text", text: JSON.stringify(value) }] }); }
      else send(request.id, undefined, { code: -32601, message: "Method not found" });
    } catch (error) { send(request.id, undefined, { code: -32000, message: error instanceof Error ? error.message : "CX bridge failed" }); }
  });
}
void main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : "CX bridge startup failed"}\n`); process.exitCode = 1; });
