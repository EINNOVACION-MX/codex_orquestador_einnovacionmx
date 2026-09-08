export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[] };
}

const tool = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): McpToolDefinition => ({ name, description, inputSchema: { type: "object", properties, required } });
const imageReferences = { type: "array", items: { type: "object", properties: { path: { type: "string" }, url: { type: "string" }, name: { type: "string" } } } };

export const mcpTools: McpToolDefinition[] = [
  tool("cx_route", "Classify a task and return CX model, reasoning, usage and budget. Does not execute. Image paths must be inside this workspace; image URLs must use HTTPS.", { task: { type: "string" }, images: imageReferences }, ["task"]),
  tool("cx_execute", "Execute a task through the CX AutoModelOrchestrator for this workspace. Native chat attachments are not passed automatically; provide accessible image paths or HTTPS URLs explicitly.", { task: { type: "string" }, images: imageReferences }, ["task"]),
  tool("cx_status", "Return Codex usage and derived budget. Never starts a turn."),
  tool("cx_project", "Return safe metadata for the current CX project."),
  tool("cx_context", "Return the compact, secret-free CX project context envelope."),
  tool("cx_capabilities", "Return the dynamically discovered Codex and CX capabilities. Never starts a turn."),
  tool("cx_agents", "Return separate Codex-native-agent availability and CX agent constraints. Never starts a turn."),
];
