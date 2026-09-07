import { BudgetController } from "../budget/budget-controller.ts";
import { MODEL_CONFIG, isReasoningSupported, supportedReasoningFor } from "../config.ts";
import type { EscalationDecision } from "../escalation/types.ts";
import { EscalationPolicy } from "../escalation/escalation-policy.ts";
import { routeTask } from "../router.ts";
import type { BudgetState, UsageSnapshot } from "../budget/types.ts";
import type { EscalationPolicyService } from "../orchestration/types.ts";
import type { ModelId, ReasoningLevel } from "../types.ts";
import { formatStatus, formatTask } from "./format.ts";
import { ProjectContextService } from "../project/project-context-service.ts";
import { validateAttachments } from "../attachments.ts";
import { CliInputError, type CliAdapter, type CliOptions, type CliResponse, type CliTaskOutput } from "./types.ts";

const STATE_PROFILE: Readonly<Record<Exclude<CliOptions["profile"], "auto">, Exclude<BudgetState, "unknown">>> = {
  balanced: "balanced", conservative: "conservative", eco: "eco", emergency: "emergency",
};
const RANK: Readonly<Record<ReasoningLevel, number>> = { none: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };

class NoEscalationPolicy implements EscalationPolicyService {
  private readonly delegate = new EscalationPolicy();
  public decide(input: Parameters<EscalationPolicyService["decide"]>[0]): EscalationDecision {
    const decision = this.delegate.decide(input);
    return decision.action === "escalate-model"
      ? { action: "require-human-review", currentModel: decision.currentModel, ...(decision.failureCategory ? { failureCategory: decision.failureCategory } : {}), reason: "Automatic model escalation was disabled by --no-escalation." }
      : decision;
  }
}

function capReasoning(model: ModelId, requested: ReasoningLevel, cap: ReasoningLevel | undefined): ReasoningLevel {
  return supportedReasoningFor(model, cap && RANK[cap] < RANK[requested] ? cap : requested);
}

function overrides(options: CliOptions): CliTaskOutput["overrides"] {
  return {
    ...(options.profile !== "auto" ? { profile: options.profile } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.reasoning ? { reasoning: options.reasoning } : {}),
    ...(options.noEscalation ? { noEscalation: true as const } : {}),
  };
}

function checkOverride(model: ModelId, reasoning: ReasoningLevel, critical: boolean): void {
  if (!isReasoningSupported(model, reasoning)) throw new CliInputError(`${model} does not support reasoning level ${reasoning}.`);
  if (critical && MODEL_CONFIG[model].rank < MODEL_CONFIG.sol.rank) throw new CliInputError("Critical security and architecture tasks require Sol or Astra.");
}

export class CliApplication {
  private readonly adapter: CliAdapter;
  private readonly cwd: string;
  public constructor(adapter: CliAdapter, cwd = process.cwd()) { this.adapter = adapter; this.cwd = cwd; }

  public async run(options: CliOptions): Promise<CliResponse> {
    try {
      if (options.command === "status") return await this.status(options);
      return await this.task(options);
    } catch (error) {
      return { exitCode: error instanceof CliInputError ? 2 : 1, stdout: "", stderr: error instanceof Error ? error.message : "Unexpected CLI error." };
    }
  }

  private async status(options: CliOptions): Promise<CliResponse> {
    const usage = await this.adapter.getUsage();
    const routingDecision = routeTask({ prompt: "status" });
    const budget = new BudgetController().evaluate({ usage, ...(options.profile !== "auto" ? { budgetStateCap: STATE_PROFILE[options.profile] } : {}), routingDecision });
    const payload = { usageSnapshot: usage, budgetState: budget.state, executionBudget: budget.executionBudget };
    return { exitCode: 0, stdout: options.json ? JSON.stringify(payload) : formatStatus(usage, budget.state), stderr: "" };
  }

  private async task(options: CliOptions): Promise<CliResponse> {
    const prompt = options.prompt as string;
    const project = new ProjectContextService();
    const snapshot = project.open(this.cwd);
    const attachments = validateAttachments(options.attachments, snapshot.metadata.rootPath);
    const initial = routeTask({ prompt, ...(attachments.length ? { hasVisualContext: true } : {}) });
    const selectedModel = options.model ?? initial.selectedModel;
    const selectedReasoning = options.reasoning ?? initial.reasoning;
    const critical = (initial.domain === "cybersecurity" && initial.risk >= 4) || (initial.domain === "architecture" && initial.risk >= 5);
    if (options.model || options.reasoning) checkOverride(selectedModel, selectedReasoning, critical);
    let usage: UsageSnapshot;
    try { usage = await this.adapter.getUsage(); } catch { usage = { source: "unknown", capturedAt: new Date().toISOString() }; }
    const routingDecision = { ...initial, selectedModel, reasoning: selectedReasoning };
    const budget = new BudgetController().evaluate({ usage, routingDecision, ...(options.model ? { minimumModel: options.model } : {}), ...(options.profile !== "auto" ? { budgetStateCap: STATE_PROFILE[options.profile] } : {}) });
    const effectiveModel = budget.preferredModel;
    const effectiveReasoning = capReasoning(effectiveModel, selectedReasoning, budget.executionBudget.reasoningCaps[effectiveModel]);
    const result = await this.adapter.executeAuto({
      prompt: project.prompt(project.envelope(snapshot), prompt), routingDecision, usageSnapshot: usage, ...(attachments.length ? { attachments } : {}), ...(options.model ? { minimumModel: options.model } : {}), ...(options.reasoning ? { minimumReasoning: options.reasoning } : {}), ...(options.profile !== "auto" ? { budgetStateCap: STATE_PROFILE[options.profile] } : {}), dryRun: options.dryRun,
    }, options.noEscalation ? { policy: new NoEscalationPolicy() } : {});
    const output: CliTaskOutput = {
      task: initial, routingDecision, usageSnapshot: usage, budgetState: result.budgetState, executionBudget: result.executionBudget,
      selectedModel: result.finalModel ?? effectiveModel, reasoning: result.finalReasoning ?? effectiveReasoning, overrides: overrides(options), ...(attachments.length ? { attachments: attachments.map(({ type, name }) => ({ type, name })) } : {}), orchestrationResult: result,
    };
    return { exitCode: result.finalStatus === "unavailable" || result.finalStatus === "failed" ? 1 : 0, stdout: options.json ? JSON.stringify(output) : formatTask(output), stderr: "" };
  }
}
