import {
  BUDGET_PROFILE_CONFIG,
  DEFAULT_BUDGET_PROFILE,
  MODEL_CONFIG,
  supportedReasoningFor,
} from "./config.ts";
import { classifyTask } from "./classifier.ts";
import type {
  ClassificationRequest,
  ClassificationResult,
  ModelId,
  ReasoningLevel,
} from "./types.ts";

function modelForComplexity(complexity: number): ModelId {
  if (complexity <= 2) return "luna";
  if (complexity <= 5) return "terra";
  if (complexity <= 8) return "sol";
  return "astra";
}

function reasoningForComplexity(complexity: number): ReasoningLevel {
  if (complexity <= 2) return "low";
  if (complexity <= 5) return "medium";
  if (complexity <= 8) return "high";
  return "xhigh";
}

function isAstraEscalationEligible(
  complexity: number,
  domain: ClassificationResult["domain"],
  failedAttempts: number,
  isCritical: boolean,
): boolean {
  return (
    complexity >= 9 &&
    failedAttempts >= 2 &&
    isCritical &&
    (domain === "architecture" || domain === "cybersecurity")
  );
}

function applyBudgetPolicy(
  candidate: ModelId,
  request: ClassificationRequest,
  classification: ReturnType<typeof classifyTask>,
): ModelId {
  if (request.modelOverride) return request.modelOverride;

  const profile = BUDGET_PROFILE_CONFIG[request.budgetProfile ?? DEFAULT_BUDGET_PROFILE];
  if (candidate !== "astra") {
    return MODEL_CONFIG[candidate].rank <= MODEL_CONFIG[profile.maximumAutomaticModel].rank
      ? candidate
      : profile.maximumAutomaticModel;
  }

  if (profile.maximumAutomaticModel === "astra") return "astra";
  if (
    profile.allowCriticalAstraEscalation &&
    isAstraEscalationEligible(
      classification.complexity,
      classification.domain,
      classification.signals.failedAttempts,
      classification.signals.isCritical,
    )
  ) {
    return "astra";
  }
  return "sol";
}

export function routeTask(request: ClassificationRequest): ClassificationResult {
  const classification = classifyTask(request);
  const candidate = modelForComplexity(classification.complexity);
  const selectedModel = applyBudgetPolicy(candidate, request, classification);
  const reasoning = supportedReasoningFor(
    selectedModel,
    reasoningForComplexity(classification.complexity),
  );

  return {
    domain: classification.domain,
    taskType: classification.taskType,
    complexity: classification.complexity,
    risk: classification.risk,
    selectedModel,
    reasoning,
    confidence: classification.confidence,
    reasons: classification.reasons,
  };
}
