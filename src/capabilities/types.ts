import type { DiscoveredCodexModel, JsonRecord } from "../codex/types.ts";
import type { ReasoningLevel } from "../types.ts";

export type CapabilityOrigin = "native-codex" | "cx" | "plugin" | "mcp" | "unavailable";
export type CapabilityStatus = "available" | "unavailable" | "unknown";

export interface CapabilityItem {
  id: string;
  name: string;
  origin: CapabilityOrigin;
  status: CapabilityStatus;
  description?: string;
  toolCount?: number;
}

export interface CapabilityModel extends DiscoveredCodexModel {
  origin: "native-codex" | "unavailable";
}

export interface CommandDefinition {
  command: string;
  description: string;
  origin?: "cx";
  arguments?: readonly string[];
}

export interface CodexCapabilitySnapshot {
  models: CapabilityModel[];
  reasoningLevels: ReasoningLevel[];
  tools: CapabilityItem[];
  mcpServers: CapabilityItem[];
  plugins: CapabilityItem[];
  skills: CapabilityItem[];
  /** The current public App Server protocol has no agent-list endpoint. */
  agents: CapabilityItem[];
  commands: CommandDefinition[];
  features: Record<string, boolean | "unknown">;
}

export interface CodexCapabilityClient {
  discoverModels(): Promise<DiscoveredCodexModel[]>;
  requestCapability?<T>(method: string, params: JsonRecord): Promise<T>;
}
