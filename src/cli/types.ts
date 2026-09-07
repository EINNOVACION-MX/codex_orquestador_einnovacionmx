import type { BudgetState, UsageSnapshot } from "../budget/types.ts";
import type { ModelId, ReasoningLevel, ClassificationResult } from "../types.ts";
import type { CxAttachment } from "../types.ts";
import type { OrchestrationRequest, OrchestrationResult } from "../orchestration/types.ts";

export type CliProfile = "auto" | "balanced" | "conservative" | "eco" | "emergency";

export interface CliOptions {
  command: "run" | "status" | "interactive";
  prompt?: string;
  dryRun: boolean;
  json: boolean;
  profile: CliProfile;
  model?: ModelId;
  reasoning?: ReasoningLevel;
  noEscalation: boolean;
  attachments?: CxAttachment[];
}

export interface CliConfig {
  profile?: CliProfile;
  output?: "human" | "json";
  dryRun?: boolean;
}

export interface CliAdapter {
  getUsage(): Promise<UsageSnapshot>;
  executeAuto(input: OrchestrationRequest, options?: { policy?: import("../orchestration/types.ts").EscalationPolicyService }): Promise<OrchestrationResult>;
  close(): Promise<void>;
  interruptActiveTurn?(): Promise<boolean>;
}

export interface CliTaskOutput {
  task: ClassificationResult;
  routingDecision: ClassificationResult;
  usageSnapshot: UsageSnapshot;
  budgetState: BudgetState;
  executionBudget: OrchestrationResult["executionBudget"];
  selectedModel: ModelId | null;
  reasoning: ReasoningLevel | null;
  overrides: { profile?: CliProfile; model?: ModelId; reasoning?: ReasoningLevel; noEscalation?: true };
  orchestrationResult?: OrchestrationResult;
  attachments?: Array<Pick<CxAttachment, "type" | "name">>;
}

export interface CliResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class CliInputError extends Error {
  public constructor(message: string) { super(message); this.name = "CliInputError"; }
}
