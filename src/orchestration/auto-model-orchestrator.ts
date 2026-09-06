import { TaskExecutionHistory } from "../history/task-execution-history.ts";
import { EscalationPolicy } from "../escalation/escalation-policy.ts";
import { MODEL_CONFIG } from "../config.ts";
import { routeTask } from "../router.ts";
import type { CodexExecutionResult } from "../codex/types.ts";
import type { EscalationDecision } from "../escalation/types.ts";
import type { TaskExecution } from "../history/types.ts";
import type { ClassificationResult, ModelId, ReasoningLevel } from "../types.ts";
import {
  DEFAULT_ATTEMPT_LIMITS,
  type AttemptLimits,
  type ExecutionService,
  type OrchestrationRequest,
  type OrchestrationResult,
  type EscalationPolicyService,
} from "./types.ts";

const RETRY_PROMPT = "Revisa el resultado del intento anterior. Corrige el fallo detectado y vuelve a validar la tarea.";

function strongerModel(left: ModelId, right: ModelId): ModelId {
  return MODEL_CONFIG[left].rank >= MODEL_CONFIG[right].rank ? left : right;
}

function decisionFor(
  base: ClassificationResult,
  selectedModel: ModelId,
  reasoning: ReasoningLevel,
): ClassificationResult {
  return { ...base, selectedModel, reasoning };
}

function countModelAttempts(execution: TaskExecution, model: ModelId): number {
  return execution.attempts.filter((attempt) => attempt.model.logical === model).length;
}

/** Executes the existing router, executor and escalation policy with hard stop limits. */
export class AutoModelOrchestrator {
  private readonly executor: ExecutionService;
  private readonly policy: EscalationPolicyService;

  public constructor(executor: ExecutionService, policy: EscalationPolicyService = new EscalationPolicy()) {
    this.executor = executor;
    this.policy = policy;
  }

  public async execute(input: OrchestrationRequest): Promise<OrchestrationResult> {
    const routingDecision = input.routingDecision ?? routeTask({
      prompt: input.prompt,
      ...(input.budgetProfile ? { budgetProfile: input.budgetProfile } : {}),
    });
    const limits = input.limits ?? DEFAULT_ATTEMPT_LIMITS;
    const historyBuilder = new TaskExecutionHistory();
    let taskExecution = input.taskExecution ?? historyBuilder.begin({
      prompt: input.prompt,
      routingDecision,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    });
    let currentModel = strongerModel(routingDecision.selectedModel, input.minimumModel ?? "luna");
    let currentReasoning = routingDecision.reasoning;
    let threadId = input.threadId ?? taskExecution.threadId ?? undefined;
    let prompt = input.prompt;
    let mustResolveExactModel = false;
    const escalations: EscalationDecision[] = [];
    let finalResult: CodexExecutionResult | undefined;

    while (true) {
      const limitReason = this.limitReason(taskExecution, currentModel, limits);
      if (limitReason) {
        return this.result(taskExecution, currentModel, currentReasoning, escalations, "limit-reached", limitReason, finalResult);
      }

      const declaredMinimum = input.minimumModel ?? "luna";
      const minimumModel = mustResolveExactModel
        ? strongerModel(declaredMinimum, currentModel)
        : declaredMinimum;
      finalResult = await this.executor.execute({
        prompt,
        routingDecision: decisionFor(routingDecision, currentModel, currentReasoning),
        ...(threadId ? { threadId } : {}),
        minimumModel,
        ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
        taskExecution,
      });
      taskExecution = finalResult.taskExecution ?? historyBuilder.complete(taskExecution, finalResult);
      threadId = finalResult.threadId ?? taskExecution.threadId ?? undefined;
      currentModel = finalResult.resolvedModel ?? currentModel;
      currentReasoning = finalResult.reasoning ?? currentReasoning;

      if (input.dryRun || finalResult.status === "dry-run") {
        return this.result(taskExecution, currentModel, currentReasoning, escalations, "dry-run", "Dry-run completed without starting a turn.", finalResult);
      }
      if (finalResult.status === "not-executed") {
        return this.result(taskExecution, currentModel, currentReasoning, escalations, "unavailable", finalResult.error ?? "No permitted Codex model could be resolved.", finalResult);
      }

      const policyDecision = this.policy.decide({
        taskExecution,
        routingDecision,
        currentModel,
        ...(input.minimumModel ? { minimumModel: input.minimumModel } : {}),
        ...(input.budgetProfile ? { budgetProfile: input.budgetProfile } : {}),
      });
      escalations.push(policyDecision);

      if (policyDecision.action === "stop-success") {
        return this.result(taskExecution, currentModel, currentReasoning, escalations, "success", policyDecision.reason, finalResult);
      }
      if (policyDecision.action === "stop-failure") {
        return this.result(taskExecution, currentModel, currentReasoning, escalations, "failed", policyDecision.reason, finalResult);
      }
      if (policyDecision.action === "require-human-review") {
        return this.result(taskExecution, currentModel, currentReasoning, escalations, "human-review", policyDecision.reason, finalResult);
      }

      if (!policyDecision.nextModel || !policyDecision.nextReasoning) {
        return this.result(taskExecution, currentModel, currentReasoning, escalations, "failed", "Escalation policy returned an incomplete continuation decision.", finalResult);
      }

      currentModel = policyDecision.nextModel;
      currentReasoning = policyDecision.nextReasoning;
      prompt = RETRY_PROMPT;
      mustResolveExactModel = policyDecision.action === "escalate-model";
    }
  }

  private limitReason(execution: TaskExecution, model: ModelId, limits: AttemptLimits): string | null {
    if (execution.attempts.length >= limits.maxTotalAttempts) {
      return `Global attempt limit (${limits.maxTotalAttempts}) reached.`;
    }
    if (countModelAttempts(execution, model) >= limits.perModel[model]) {
      return `${model} attempt limit (${limits.perModel[model]}) reached.`;
    }
    return null;
  }

  private result(
    taskExecution: TaskExecution,
    finalModel: ModelId | null,
    finalReasoning: ReasoningLevel | null,
    escalations: EscalationDecision[],
    finalStatus: OrchestrationResult["finalStatus"],
    stoppedReason: string,
    finalResult?: CodexExecutionResult,
  ): OrchestrationResult {
    return {
      taskExecution,
      finalStatus,
      finalModel,
      finalReasoning,
      totalAttempts: taskExecution.attempts.length,
      escalations,
      ...(finalResult ? { finalResult } : {}),
      stoppedReason,
    };
  }
}
