import { MODEL_CONFIG } from "../config.ts";
import { mcpTools } from "../mcp/tools.ts";
import type { ModelId, ReasoningLevel } from "../types.ts";
import type { JsonRecord } from "../codex/types.ts";
import type { CapabilityItem, CapabilityModel, CodexCapabilityClient, CodexCapabilitySnapshot, CommandDefinition } from "./types.ts";

export const CX_COMMANDS: readonly CommandDefinition[] = [
  { command: "/help", description: "Command reference" },
  { command: "/about", description: "About CX" },
  { command: "/status", description: "Usage and budget" },
  { command: "/project", description: "Current project" },
  { command: "/context", description: "Compact project context" },
  { command: "/threads", description: "Known CX threads" },
  { command: "/agents", description: "CX agent constraints", arguments: ["auto", "frontend", "backend", "security", "architecture", "code-review", "automation"] },
  { command: "/skills", description: "Available Codex skills" },
  { command: "/plugins", description: "Installed plugins" },
  { command: "/mcp", description: "Known MCP servers" },
  { command: "/tools", description: "Tools by origin" },
  { command: "/model", description: "Model or AUTO", arguments: ["auto", "luna", "terra", "sol", "astra"] },
  { command: "/reasoning", description: "Reasoning level", arguments: ["auto", "none", "low", "medium", "high", "xhigh", "max"] },
  { command: "/profile", description: "Budget profile", arguments: ["auto", "balanced", "conservative", "eco", "emergency"] },
  { command: "/image", description: "Attach image" },
  { command: "/images", description: "List or clear images", arguments: ["clear"] },
  { command: "/new", description: "Start a new CX thread" },
  { command: "/interrupt", description: "Interrupt current turn" },
  { command: "/reindex", description: "Rebuild project context" },
  { command: "/exit", description: "Close CX" },
];

const reasoning = new Set<ReasoningLevel>();
const asRecord = (value: unknown): JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : {};
const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);
const rows = (value: unknown): JsonRecord[] => {
  const record = asRecord(value);
  for (const key of ["data", "items", "skills", "plugins", "servers", "tools", "marketplaces"]) {
    if (Array.isArray(record[key])) return record[key].map(asRecord);
  }
  return [];
};
const text = (value: unknown, fallback: string): string => typeof value === "string" && value.trim() ? value : fallback;
const item = (row: JsonRecord, origin: CapabilityItem["origin"], fallback: string): CapabilityItem => ({
  id: text(row.id ?? row.name ?? row.serverId ?? row.pluginId, fallback),
  name: text(row.displayName ?? row.name ?? row.id ?? row.serverId ?? row.pluginId, fallback),
  origin,
  status: row.enabled === false || row.available === false ? "unavailable" : row.status === "error" ? "unavailable" : "available",
  ...(typeof row.description === "string" ? { description: row.description.slice(0, 180) } : {}),
  ...(typeof row.toolCount === "number" ? { toolCount: row.toolCount } : Array.isArray(row.tools) ? { toolCount: row.tools.length } : isRecord(row.tools) ? { toolCount: Object.keys(row.tools).length } : {}),
});

/**
 * Dynamic inventory for public App Server discovery methods. Each optional
 * endpoint fails independently so a Codex update cannot disable CX routing.
 */
export class CodexCapabilityRegistry {
  private readonly client: CodexCapabilityClient;
  public constructor(client: CodexCapabilityClient) { this.client = client; }

  public async discover(cwd?: string): Promise<CodexCapabilitySnapshot> {
    const models = await this.models();
    const query = <T>(method: string, params: JsonRecord): Promise<T | undefined> => this.client.requestCapability
      ? this.client.requestCapability<T>(method, params).catch(() => undefined)
      : Promise.resolve(undefined);
    const [skillsRaw, pluginsRaw, mcpRaw, featuresRaw] = await Promise.all([
      query<unknown>("skills/list", cwd ? { cwds: [cwd] } : {}),
      query<unknown>("plugin/list", cwd ? { cwds: [cwd] } : {}),
      query<unknown>("mcpServerStatus/list", { detail: "full" }),
      query<unknown>("experimentalFeature/list", {}),
    ]);
    const skills = this.skillItems(skillsRaw);
    const plugins = this.pluginItems(pluginsRaw);
    const mcpServers = this.items(mcpRaw, "mcp", "mcp-server");
    const mcpTools = rows(mcpRaw).flatMap((server) => toolRows(server.tools)
      .map((tool, index) => item(tool, "mcp", `${text(server.name, "mcp")}-tool-${index + 1}`)));
    const cxTools = mcpToolsFromCx();
    return {
      models,
      reasoningLevels: [...reasoning].sort((a, b) => rank(a) - rank(b)),
      tools: [...cxTools, ...mcpTools],
      mcpServers,
      plugins,
      skills,
      agents: [{ id: "native-agents", name: "Codex Native Agents", origin: "unavailable", status: "unavailable", description: "This App Server version has no public agent-list endpoint. CX agents are separate routing constraints." }],
      commands: [...CX_COMMANDS],
      features: featureMap(featuresRaw),
    };
  }

  private async models(): Promise<CapabilityModel[]> {
    reasoning.clear();
    try {
      const discovered = await this.client.discoverModels();
      for (const model of discovered) for (const level of model.reasoningLevels) reasoning.add(level);
      const known = new Map<ModelId, CapabilityModel>();
      for (const model of discovered) if (model.logicalName) known.set(model.logicalName, { ...model, origin: "native-codex" });
      return (Object.keys(MODEL_CONFIG) as ModelId[]).map((logicalName) => known.get(logicalName) ?? {
        logicalName,
        realModelId: MODEL_CONFIG[logicalName].codexModel,
        displayName: logicalName[0]!.toUpperCase() + logicalName.slice(1),
        reasoningLevels: [], available: false, isDefault: false, origin: "unavailable",
      });
    } catch {
      return (Object.keys(MODEL_CONFIG) as ModelId[]).map((logicalName) => ({ logicalName, realModelId: MODEL_CONFIG[logicalName].codexModel, displayName: logicalName[0]!.toUpperCase() + logicalName.slice(1), reasoningLevels: [], available: false, isDefault: false, origin: "unavailable" }));
    }
  }
  private items(raw: unknown, origin: CapabilityItem["origin"], fallback: string): CapabilityItem[] {
    return rows(raw).map((row, index) => item(row, origin, `${fallback}-${index + 1}`));
  }
  private skillItems(raw: unknown): CapabilityItem[] {
    return rows(raw).flatMap((group) => Array.isArray(group.skills) ? group.skills.map(asRecord) : [group])
      .map((skill, index) => item(skill, "native-codex", `skill-${index + 1}`));
  }
  private pluginItems(raw: unknown): CapabilityItem[] {
    return rows(raw).flatMap((marketplace) => Array.isArray(marketplace.plugins) ? marketplace.plugins.map(asRecord) : [marketplace])
      .filter((plugin) => plugin.installed === true || plugin.enabled === true)
      .map((plugin, index) => item(plugin, "plugin", `plugin-${index + 1}`));
  }
}

function mcpToolsFromCx(): CapabilityItem[] { return mcpTools.map((tool) => ({ id: tool.name, name: tool.name, origin: "cx", status: "available", description: tool.description })); }
function toolRows(raw: unknown): JsonRecord[] { return Array.isArray(raw) ? raw.map(asRecord) : isRecord(raw) ? Object.values(raw).map(asRecord) : []; }
function featureMap(raw: unknown): Record<string, boolean | "unknown"> {
  const result: Record<string, boolean | "unknown"> = {};
  for (const entry of rows(raw)) result[text(entry.name ?? entry.id, "feature")] = typeof entry.enabled === "boolean" ? entry.enabled : "unknown";
  return result;
}
function rank(level: ReasoningLevel): number { return (["none", "low", "medium", "high", "xhigh", "max"] as const).indexOf(level); }
