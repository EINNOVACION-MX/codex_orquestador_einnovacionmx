export const MODEL_IDS = ["luna", "terra", "sol", "astra"] as const;
export type ModelId = (typeof MODEL_IDS)[number];

export const REASONING_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export const DOMAINS = [
  "web-development",
  "backend",
  "frontend",
  "database",
  "crm",
  "automation",
  "n8n",
  "ai-agents",
  "debugging",
  "architecture",
  "cybersecurity",
  "general",
] as const;
export type TaskDomain = (typeof DOMAINS)[number];

export const TASK_TYPES = [
  "style-change",
  "feature",
  "bugfix",
  "analysis",
  "review",
  "architecture",
  "security",
  "automation",
  "general",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const BUDGET_PROFILES = ["economy", "balanced", "quality"] as const;
export type BudgetProfileName = (typeof BUDGET_PROFILES)[number];

export interface ClassificationRequest {
  prompt: string;
  hasVisualContext?: boolean;
  budgetProfile?: BudgetProfileName;
  /** Metadata supplied by the caller is preferred over phrases found in the prompt. */
  failedAttempts?: number;
  previousModel?: ModelId;
  modelOverride?: ModelId;
}

export interface ClassificationResult {
  domain: TaskDomain;
  taskType: TaskType;
  /** 1 means trivial; 10 means an extreme task that merits an escalation review. */
  complexity: number;
  /** 1 means low blast radius; 5 means critical or production-sensitive. */
  risk: number;
  selectedModel: ModelId;
  reasoning: ReasoningLevel;
  confidence: number;
  reasons: string[];
  hasVisualContext?: boolean;
}

export interface CxAttachment { type: "image"; path?: string; url?: string; mimeType?: string; name?: string; detail?: "auto" | "low" | "high" | "original"; }
export interface ResolvedCxAttachment { type: "image"; name: string; mimeType: string; path?: string; url?: string; detail?: "auto" | "low" | "high" | "original"; }

export interface ModelConfig {
  id: ModelId;
  codexModel: string;
  supportedReasoning: readonly ReasoningLevel[];
  defaultReasoning: ReasoningLevel;
  rank: number;
}

export interface BudgetProfile {
  name: BudgetProfileName;
  /** Highest model normally selected by a new task. */
  maximumAutomaticModel: ModelId;
  /** Whether a critical, proven escalation can use Astra. */
  allowCriticalAstraEscalation: boolean;
}

export interface RoutingSignals {
  failedAttempts: number;
  detectedDatabaseWork: boolean;
  detectedPaymentOrProductionWork: boolean;
  detectedConcurrency: boolean;
  isCritical: boolean;
}
