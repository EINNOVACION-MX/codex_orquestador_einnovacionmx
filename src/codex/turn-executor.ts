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

function isTurnCompletedFor(
  notification: CodexNotification,
  threadId: string,
  turnId: string,
): notification is CodexNotification & { params: { threadId: string; turn: CodexTurn } } {
  const params = notification.params;
  const turn = params.turn;
  return (
    notification.method === "turn/completed" &&
    params.threadId === threadId &&
    typeof turn === "object" &&
    turn !== null &&
    "id" in turn &&
    (turn as CodexTurn).id === turnId
  );
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
      const turnWaiter = this.waitForTurnCompletion(managedThread.threadId);
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
      return withHistory(this.executionResult(resolution, managedThread.threadId, completed, startedAt));
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

  private waitForTurnCompletion(threadId: string): {
    wait: (turnId: string) => Promise<CodexTurn>;
    dispose: () => void;
  } {
    const completedTurns = new Map<string, CodexTurn>();
    const waiters = new Map<string, (turn: CodexTurn) => void>();
    const removeListener = this.transport.onNotification((notification) => {
      if (notification.method !== "turn/completed") return;
      const params = notification.params;
      if (params.threadId !== threadId || typeof params.turn !== "object" || params.turn === null) return;
      const turn = params.turn as CodexTurn;
      if (typeof turn.id !== "string") return;
      const waiter = waiters.get(turn.id);
      if (waiter) {
        waiters.delete(turn.id);
        removeListener();
        waiter(turn);
        return;
      }
      completedTurns.set(turn.id, turn);
    });

    return {
      wait: async (turnId: string): Promise<CodexTurn> => {
      const completed = completedTurns.get(turnId);
      if (completed) {
        removeListener();
        return completed;
      }
      return new Promise<CodexTurn>((resolve) => {
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
      ...(turn.error?.message ? { error: turn.error.message } : {}),
    };
  }
}
