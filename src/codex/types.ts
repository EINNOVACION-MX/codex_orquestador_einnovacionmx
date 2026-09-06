import type {
  ClassificationResult,
  ModelId,
  ReasoningLevel,
} from "../types.ts";
import type { TaskExecution, TestResult } from "../history/types.ts";

export type JsonRecord = Record<string, unknown>;

export interface CodexTransport {
  request<T>(method: string, params: JsonRecord): Promise<T>;
  notify(method: string, params: JsonRecord): void;
  onNotification(listener: CodexNotificationListener): () => void;
  close(): Promise<void>;
}

export interface CodexNotification {
  method: string;
  params: JsonRecord;
}

export type CodexNotificationListener = (notification: CodexNotification) => void;

export interface CodexRawModel {
  id: string;
  model: string;
  displayName: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
}

export interface CodexModelListResponse {
  data: CodexRawModel[];
  nextCursor?: string | null;
}

export interface DiscoveredCodexModel {
  logicalName: ModelId | null;
  realModelId: string;
  displayName: string;
  reasoningLevels: ReasoningLevel[];
  available: boolean;
  isDefault: boolean;
}

export interface ModelResolutionRequest {
  selectedModel: ModelId;
  requestedReasoning: ReasoningLevel;
  minimumModel?: ModelId;
}

export type ModelResolutionStatus =
  | "resolved"
  | "minimum-model-unavailable"
  | "model-unavailable";

export interface ModelResolution {
  status: ModelResolutionStatus;
  requestedModel: ModelId;
  resolvedModel: ModelId | null;
  realModelId: string | null;
  reasoning: ReasoningLevel | null;
  fallbackUsed: boolean;
  error?: string;
}

export interface CodexThread {
  id: string;
  sessionId?: string;
}

export interface CodexThreadResponse {
  thread: CodexThread;
}

export interface ManagedThread {
  threadId: string;
  created: boolean;
}

export interface CodexTurn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  durationMs?: number | null;
  error?: { message: string } | null;
}

export interface CodexTurnResponse {
  turn: CodexTurn;
}

export interface TurnCompletedNotification {
  threadId: string;
  turn: CodexTurn;
}

export interface CodexExecutionRequest {
  prompt: string;
  routingDecision: ClassificationResult;
  threadId?: string;
  minimumModel?: ModelId;
  dryRun?: boolean;
  cwd?: string;
  taskExecution?: TaskExecution;
  testResult?: TestResult;
}

export type CodexExecutionStatus =
  | "completed"
  | "failed"
  | "interrupted"
  | "inProgress"
  | "dry-run"
  | "not-executed"
  | "error";

export interface CodexExecutionResult {
  requestedModel: ModelId;
  resolvedModel: ModelId | null;
  reasoning: ReasoningLevel | null;
  threadId: string | null;
  status: CodexExecutionStatus;
  fallbackUsed: boolean;
  durationMs: number;
  realModelId?: string | null;
  taskExecution?: TaskExecution;
  error?: string;
}
