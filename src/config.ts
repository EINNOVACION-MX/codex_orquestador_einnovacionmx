import type {
  BudgetProfile,
  BudgetProfileName,
  ModelConfig,
  ModelId,
  ReasoningLevel,
} from "./types.ts";

export const MODEL_CONFIG: Readonly<Record<ModelId, ModelConfig>> = {
  luna: {
    id: "luna",
    codexModel: "gpt-5.6-luna",
    supportedReasoning: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultReasoning: "medium",
    rank: 1,
  },
  terra: {
    id: "terra",
    codexModel: "gpt-5.6-terra",
    supportedReasoning: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultReasoning: "medium",
    rank: 2,
  },
  sol: {
    id: "sol",
    codexModel: "gpt-5.6-sol",
    supportedReasoning: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultReasoning: "medium",
    rank: 3,
  },
  astra: {
    id: "astra",
    codexModel: "gpt-6-astra",
    supportedReasoning: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoning: "medium",
    rank: 4,
  },
};

export const BUDGET_PROFILE_CONFIG: Readonly<
  Record<BudgetProfileName, BudgetProfile>
> = {
  economy: {
    name: "economy",
    maximumAutomaticModel: "terra",
    allowCriticalAstraEscalation: false,
  },
  balanced: {
    name: "balanced",
    maximumAutomaticModel: "sol",
    allowCriticalAstraEscalation: true,
  },
  quality: {
    name: "quality",
    maximumAutomaticModel: "astra",
    allowCriticalAstraEscalation: true,
  },
};

export const DEFAULT_BUDGET_PROFILE: BudgetProfileName = "balanced";

const REASONING_RANK: Readonly<Record<ReasoningLevel, number>> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

export function isReasoningSupported(
  model: ModelId,
  reasoning: ReasoningLevel,
): boolean {
  return MODEL_CONFIG[model].supportedReasoning.includes(reasoning);
}

/** Finds the nearest supported level at or below the requested one. */
export function supportedReasoningFor(
  model: ModelId,
  requested: ReasoningLevel,
): ReasoningLevel {
  const available = MODEL_CONFIG[model].supportedReasoning;
  const requestedRank = REASONING_RANK[requested];
  const candidate = [...available]
    .reverse()
    .find((level) => REASONING_RANK[level] <= requestedRank);

  return candidate ?? MODEL_CONFIG[model].defaultReasoning;
}
