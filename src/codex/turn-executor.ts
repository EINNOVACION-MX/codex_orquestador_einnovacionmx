import { performance } from "node:perf_hooks";
import { CodexModelResolver } from "./model-resolver.ts";
import { CodexThreadManager } from "./thread-manager.ts";
import { TaskExecutionHistory } from "../history/task-execution-history.ts";
import type {
  CodexExecutionRequest,
  CodexExecutionResult,
  CodexNotification,
  CodexTransport,
  CodexTurn,
  CodexTurnResponse,
  ModelResolution,
  ActiveTurn,
} from "./types.ts";
import { attachmentInputs } from "../attachments.ts";

interface CompletedTurnCapture {
  turn: CodexTurn;
  agentMessage?: string;
  notices: string[];
}

function agentText(item: unknown): string | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const record = item as Record<string, unknown>;
  return record.type === "agentMessage" && typeof record.text === "string" && record.text.trim()
    ? record.text.trim()
    : undefined;
}

function noticeFor(notification: CodexNotification): string | undefined {
  if (notification.method === "autoApprovalReview/strictReviewRequired") return "Approval is required before Codex can continue.";
  if (notification.method === "item/autoApprovalReview/started") return "Codex is waiting for approval review.";
  if (notification.method !== "item/completed") return undefined;
  const item = notification.params.item;
  if (typeof item !== "object" || item === null) return undefined;
  const questions = (item as Record<string, unknown>).questions;
  return Array.isArray(questions) && questions.length > 0 ? "Codex needs your input before it can continue." : undefined;
}

function resultFromResolution(
  resolution: ModelResolution,
  durationMs: number,
  status: "dry-run" | "not-executed" | "error",
  threadId: string | null = null,
): CodexExecutionResult {
  return {
    requestedModel: resolution.requestedModel,
    resolvedModel: resolution.resolvedModel,
    reasoning: resolution.reasoning,
    threadId,
    status,
    fallbackUsed: resolution.fallbackUsed,
    durationMs,
    ...(resolution.realModelId ? { realModelId: resolution.realModelId } : {}),
    ...(resolution.error ? { error: resolution.error } : {}),
  };
}

export class CodexTurnExecutor {
  private readonly transport: CodexTransport;
  private readonly modelResolver: CodexModelResolver;
  private readonly threadManager: CodexThreadManager;
  private activeTurn: ActiveTurn | undefined;
  private interrupting = false;

  public constructor(
    transport: CodexTransport,
    modelResolver: CodexModelResolver,
    threadManager: CodexThreadManager,
  ) {
    this.transport = transport;
    this.modelResolver = modelResolver;
    this.threadManager = threadManager;
  }
  public getActiveTurn(): ActiveTurn | undefined { return this.activeTurn; }
  public async interruptActiveTurn(): Promise<boolean> {
    const active = this.activeTurn;
    if (!active || this.interrupting) return false;
    this.interrupting = true;
    try { await this.transport.request("turn/interrupt", { threadId: active.threadId, turnId: active.turnId }); return true; }
    finally { this.interrupting = false; }
  }

  public async execute(input: CodexExecutionRequest): Promise<CodexExecutionResult> {
    const startedAt = performance.now();
    const attemptStartedAt = new Date().toISOString();
    const history = new TaskExecutionHistory();
    const execution = history.begin(
      {
        prompt: input.prompt,
        routingDecision: input.routingDecision,
        ...(input.threadId ? { threadId: input.threadId } : {}),
      },
      input.taskExecution,
    );
    const withHistory = (result: CodexExecutionResult): CodexExecutionResult => ({
      ...result,
      taskExecution: history.complete(execution, result, input.testResult, attemptStartedAt),
    });
    let resolution: ModelResolution;

    try {
      const catalog = await this.modelResolver.discover();
      resolution = this.modelResolver.resolve(catalog, {
        selectedModel: input.routingDecision.selectedModel,
        requestedReasoning: input.routingDecision.reasoning,
        ...(input.minimumModel ? { minimumModel: input.minimumModel } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Codex model discovery failed.";
      return withHistory({
        requestedModel: input.routingDecision.selectedModel,
        resolvedModel: null,
        reasoning: null,
        threadId: null,
        status: "error",
        fallbackUsed: false,
        durationMs: Math.round(performance.now() - startedAt),
        error: message,
      });
    }

    if (
      resolution.status !== "resolved" ||
      !resolution.realModelId ||
      !resolution.reasoning
    ) {
      return withHistory(resultFromResolution(
        resolution,
        Math.round(performance.now() - startedAt),
        "not-executed",
      ));
    }

    if (input.dryRun) {
      return withHistory(resultFromResolution(
        resolution,
        Math.round(performance.now() - startedAt),
        "dry-run",
        input.threadId ?? null,
      ));
    }

    let activeThreadId = input.threadId ?? null;
    try {
      const managedThread = await this.threadManager.getOrCreate({
        ...(input.threadId ? { threadId: input.threadId } : {}),
        realModelId: resolution.realModelId,
      });
      activeThreadId = managedThread.threadId;
      const turnWaiter = this.waitForTurnCompletion(managedThread.threadId, input.onEvent);
      const startedTurn = await this.transport.request<CodexTurnResponse>("turn/start", {
        threadId: managedThread.threadId,
        input: [{ type: "text", text: input.prompt }, ...attachmentInputs(input.attachments ?? [])],
        model: resolution.realModelId,
        effort: resolution.reasoning,
        ...(input.cwd ? { cwd: input.cwd } : {}),
      });

      if (!startedTurn.turn || typeof startedTurn.turn.id !== "string") {
        throw new Error("Codex returned an unexpected turn/start response.");
      }
      this.activeTurn = { threadId: managedThread.threadId, turnId: startedTurn.turn.id, model: resolution.resolvedModel!, reasoning: resolution.reasoning, startedAt: attemptStartedAt };

      if (startedTurn.turn.status !== "inProgress") {
        turnWaiter.dispose();
        return withHistory(this.executionResult(resolution, managedThread.threadId, startedTurn.turn, startedAt));
      }

      const completed = await turnWaiter.wait(startedTurn.turn.id);
      return withHistory(this.executionResult(resolution, managedThread.threadId, completed.turn, startedAt, completed.agentMessage, completed.notices));
    } catch (error) {
      return withHistory({
        ...resultFromResolution(
          resolution,
          Math.round(performance.now() - startedAt),
          "error",
          activeThreadId,
        ),
        error: error instanceof Error ? error.message : "Codex turn execution failed.",
      });
    } finally { this.activeTurn = undefined; }
  }

  private waitForTurnCompletion(threadId: string, onEvent?: CodexExecutionRequest["onEvent"]): {
    wait: (turnId: string) => Promise<CompletedTurnCapture>;
    dispose: () => void;
  } {
    const completedTurns = new Map<string, CompletedTurnCapture>();
    const waiters = new Map<string, (turn: CompletedTurnCapture) => void>();
    const messages = new Map<string, Map<string, string>>();
    const notices = new Map<string, string[]>();
    const addNotice = (turnId: string, notice: string): void => {
      const values = notices.get(turnId) ?? [];
      if (!values.includes(notice)) values.push(notice);
      notices.set(turnId, values);
    };
    const messageFor = (turnId: string): string | undefined => {
      const values = [...(messages.get(turnId)?.values() ?? [])].filter(Boolean);
      return values.length ? values.join("\n\n") : undefined;
    };
    const removeListener = this.transport.onNotification((notification) => {
      const params = notification.params;
      if (params.threadId !== threadId) return;
      const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
      if (notification.method === "item/agentMessage/delta" && typeof params.itemId === "string" && typeof params.delta === "string") {
        if (!turnId) return;
        const values = messages.get(turnId) ?? new Map<string, string>();
        values.set(params.itemId, `${values.get(params.itemId) ?? ""}${params.delta}`);
        messages.set(turnId, values);
        onEvent?.({ type: "agent-message-delta", delta: params.delta });
        return;
      }
      if (notification.method === "item/completed") {
        if (!turnId) return;
        const message = agentText(params.item);
        const item = params.item as Record<string, unknown> | undefined;
        if (message && typeof item?.id === "string") {
          const values = messages.get(turnId) ?? new Map<string, string>();
          values.set(item.id, message);
          messages.set(turnId, values);
          onEvent?.({ type: "agent-message-completed", message });
        }
        const notice = noticeFor(notification);
        if (notice) { addNotice(turnId, notice); onEvent?.({ type: "notice", message: notice }); }
        return;
      }
      const notice = noticeFor(notification);
      if (notice) { if (turnId) { addNotice(turnId, notice); onEvent?.({ type: "notice", message: notice }); } return; }
      if (notification.method !== "turn/completed" || typeof params.turn !== "object" || params.turn === null) return;
      const turn = params.turn as CodexTurn;
      if (typeof turn.id !== "string") return;
      const message = messageFor(turn.id);
      const completed: CompletedTurnCapture = { turn, ...(message ? { agentMessage: message } : {}), notices: notices.get(turn.id) ?? [] };
      const waiter = waiters.get(turn.id);
      if (waiter) {
        waiters.delete(turn.id);
        removeListener();
        waiter(completed);
        return;
      }
      completedTurns.set(turn.id, completed);
    });

    return {
      wait: async (turnId: string): Promise<CompletedTurnCapture> => {
      const completed = completedTurns.get(turnId);
      if (completed) {
        removeListener();
        return completed;
      }
      return new Promise<CompletedTurnCapture>((resolve) => {
        waiters.set(turnId, resolve);
      });
      },
      dispose: removeListener,
    };
  }

  private executionResult(
    resolution: ModelResolution,
    threadId: string,
    turn: CodexTurn,
    startedAt: number,
    agentMessage?: string,
    notices: string[] = [],
  ): CodexExecutionResult {
    return {
      requestedModel: resolution.requestedModel,
      resolvedModel: resolution.resolvedModel,
      reasoning: resolution.reasoning,
      threadId,
      status: turn.status,
      fallbackUsed: resolution.fallbackUsed,
      durationMs: turn.durationMs ?? Math.round(performance.now() - startedAt),
      ...(resolution.realModelId ? { realModelId: resolution.realModelId } : {}),
      ...(agentMessage ? { agentMessage } : {}),
      ...(notices.length ? { notices } : {}),
      ...(turn.error?.message ? { error: turn.error.message } : {}),
    };
  }
}
