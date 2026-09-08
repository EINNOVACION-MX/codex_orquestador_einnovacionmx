import { MODEL_CONFIG } from "../config.ts";
import type { ModelId } from "../types.ts";
import type { CapabilityItem } from "../capabilities/types.ts";

export type CxAgentId = "auto" | "frontend" | "backend" | "security" | "architecture" | "code-review" | "automation";
export interface CxAgentDefinition { id: CxAgentId; name: string; description: string; minimumModel?: ModelId; context: string; }

export const CX_AGENTS: readonly CxAgentDefinition[] = [
  { id: "auto", name: "AUTO", description: "No additional routing constraints.", context: "" },
  { id: "frontend", name: "Frontend", description: "UI, accessibility and client-side implementation.", context: "Prioritize frontend quality, accessibility and responsive behavior." },
  { id: "backend", name: "Backend", description: "APIs, services and integrations.", context: "Prioritize API contracts, data integrity and operational safety." },
  { id: "security", name: "Security", description: "Security review or hardening. Requires Sol or Astra.", minimumModel: "sol", context: "Treat this as a security-focused task. Verify authorization, input handling, secrets and safe remediation." },
  { id: "architecture", name: "Architecture", description: "System design and high-impact technical decisions.", minimumModel: "sol", context: "Treat this as an architecture task. State tradeoffs and preserve system boundaries." },
  { id: "code-review", name: "Code Review", description: "Review changes for correctness and regressions.", context: "Review for correctness, regressions, tests and maintainability." },
  { id: "automation", name: "Automation / n8n", description: "Workflows, integrations and n8n automation.", context: "Prioritize idempotency, retries, observability and safe workflow behavior." },
];

export function getCxAgent(id: string | undefined): CxAgentDefinition | undefined { return CX_AGENTS.find((agent) => agent.id === id); }
export function cxAgentCapabilities(): CapabilityItem[] { return CX_AGENTS.map((agent) => ({ id: agent.id, name: agent.name, origin: "cx", status: "available", description: agent.description })); }
export function strongerModel(first: ModelId, second: ModelId | undefined): ModelId { return second && MODEL_CONFIG[second].rank > MODEL_CONFIG[first].rank ? second : first; }
