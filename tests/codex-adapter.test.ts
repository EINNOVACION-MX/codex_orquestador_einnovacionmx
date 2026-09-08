import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CodexModelResolver } from "../src/codex/model-resolver.ts";
import { CodexThreadManager } from "../src/codex/thread-manager.ts";
import { CodexTurnExecutor } from "../src/codex/turn-executor.ts";
import { codexChildEnvironment } from "../src/codex/stdio-transport.ts";
import type {
  CodexNotification,
  CodexNotificationListener,
  CodexRawModel,
  CodexTransport,
  JsonRecord,
} from "../src/codex/types.ts";
import { routeTask } from "../src/router.ts";

type Handler = unknown | Error | ((params: JsonRecord, transport: FakeTransport) => unknown);

class FakeTransport implements CodexTransport {
  public readonly requests: Array<{ method: string; params: JsonRecord }> = [];
  private readonly handlers = new Map<string, Handler>();
  private readonly listeners = new Set<CodexNotificationListener>();

  public respond(method: string, handler: Handler): this {
    this.handlers.set(method, handler);
    return this;
  }

  public async request<T>(method: string, params: JsonRecord): Promise<T> {
    this.requests.push({ method, params });
    const handler = this.handlers.get(method);
    if (handler instanceof Error) throw handler;
    if (typeof handler === "function") return handler(params, this) as T;
    return handler as T;
  }

  public notify(): void {}

  public onNotification(listener: CodexNotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async close(): Promise<void> {}

  public emit(notification: CodexNotification): void {
    for (const listener of this.listeners) listener(notification);
  }
}

function model(
  id: string,
  reasoningEfforts: string[] = ["low", "medium", "high", "xhigh"],
  hidden = false,
): CodexRawModel {
  return {
    id,
    model: id,
    displayName: id,
    hidden,
    isDefault: id === "gpt-5.6-terra",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: reasoningEfforts.map((reasoningEffort) => ({ reasoningEffort })),
  };
}

function transportWithModels(models: CodexRawModel[]): FakeTransport {
  return new FakeTransport().respond("model/list", { data: models });
}

function executor(transport: FakeTransport): CodexTurnExecutor {
  const resolver = new CodexModelResolver(transport);
  return new CodexTurnExecutor(transport, resolver, new CodexThreadManager(transport));
}

describe("CodexModelResolver", () => {
  it("uses the directly selected real Codex model", async () => {
    const transport = transportWithModels([model("gpt-5.6-terra")]);
    const resolver = new CodexModelResolver(transport);
    const decision = resolver.resolve(await resolver.discover(), {
      selectedModel: "terra",
      requestedReasoning: "medium",
    });

    assert.deepEqual(decision, {
      status: "resolved",
      requestedModel: "terra",
      resolvedModel: "terra",
      realModelId: "gpt-5.6-terra",
      reasoning: "medium",
      fallbackUsed: false,
    });
  });

  it("falls back from Astra to Sol when Astra is unavailable", async () => {
    const transport = transportWithModels([model("gpt-5.6-sol")]);
    const resolver = new CodexModelResolver(transport);
    const decision = resolver.resolve(await resolver.discover(), {
      selectedModel: "astra",
      requestedReasoning: "xhigh",
    });

    assert.equal(decision.status, "resolved");
    assert.equal(decision.resolvedModel, "sol");
    assert.equal(decision.realModelId, "gpt-5.6-sol");
    assert.equal(decision.fallbackUsed, true);
  });

  it("does not degrade below minimumModel", async () => {
    const transport = transportWithModels([model("gpt-5.6-terra")]);
    const resolver = new CodexModelResolver(transport);
    const decision = resolver.resolve(await resolver.discover(), {
      selectedModel: "sol",
      requestedReasoning: "high",
      minimumModel: "sol",
    });

    assert.equal(decision.status, "minimum-model-unavailable");
    assert.equal(decision.resolvedModel, null);
    assert.match(decision.error ?? "", /sol minimum capability/);
  });

  it("uses the highest compatible reasoning level without exceeding the request", async () => {
    const transport = transportWithModels([model("gpt-6-astra", ["low", "high"])]);
    const resolver = new CodexModelResolver(transport);
    const decision = resolver.resolve(await resolver.discover(), {
      selectedModel: "astra",
      requestedReasoning: "xhigh",
    });

    assert.equal(decision.status, "resolved");
    assert.equal(decision.reasoning, "high");
  });

  it("returns a controlled result when no known Codex model exists", async () => {
    const transport = transportWithModels([model("gpt-unknown")]);
    const resolver = new CodexModelResolver(transport);
    const decision = resolver.resolve(await resolver.discover(), {
      selectedModel: "terra",
      requestedReasoning: "medium",
    });

    assert.equal(decision.status, "minimum-model-unavailable");
    assert.equal(decision.realModelId, null);
  });
});

describe("CodexStdioTransport environment", () => {
  it("preserves the local Codex environment and fills only missing Windows home variables", () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const env = codexChildEnvironment({ USERPROFILE: "D:\\Profiles\\cx", APPDATA: "D:\\Data\\Roaming", LOCALAPPDATA: "D:\\Data\\Local", PATH: "existing" });
      assert.equal(env.HOME, "D:\\Profiles\\cx"); assert.equal(env.HOMEDRIVE, "D:"); assert.equal(env.HOMEPATH, "\\Profiles\\cx");
      assert.equal(env.APPDATA, "D:\\Data\\Roaming"); assert.equal(env.LOCALAPPDATA, "D:\\Data\\Local"); assert.equal(env.PATH, "existing");
      assert.equal(codexChildEnvironment({ HOME: "custom", USERPROFILE: "D:\\Profiles\\cx" }).HOME, "custom");
    } finally { if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform); }
  });
});

describe("CodexThreadManager", () => {
  it("creates a new Codex thread", async () => {
    const transport = new FakeTransport().respond("thread/start", { thread: { id: "thread-new" } });
    const thread = await new CodexThreadManager(transport).getOrCreate({
      realModelId: "gpt-5.6-terra",
    });

    assert.deepEqual(thread, { threadId: "thread-new", created: true });
    assert.deepEqual(transport.requests[0], {
      method: "thread/start",
      params: { model: "gpt-5.6-terra", serviceName: "codex-auto-model-router" },
    });
  });

  it("resumes an existing Codex thread with the resolved model", async () => {
    const transport = new FakeTransport().respond("thread/resume", { thread: { id: "thread-existing" } });
    const thread = await new CodexThreadManager(transport).getOrCreate({
      threadId: "thread-existing",
      realModelId: "gpt-5.6-sol",
    });

    assert.deepEqual(thread, { threadId: "thread-existing", created: false });
    assert.deepEqual(transport.requests[0], {
      method: "thread/resume",
      params: { threadId: "thread-existing", model: "gpt-5.6-sol" },
    });
  });
});

describe("CodexTurnExecutor", () => {
  it("returns a communication error without starting a thread", async () => {
    const transport = new FakeTransport().respond("model/list", new Error("connection lost"));
    const result = await executor(transport).execute({
      prompt: "Cambia el padding del navbar",
      routingDecision: routeTask({ prompt: "Cambia el padding del navbar" }),
    });

    assert.equal(result.status, "error");
    assert.match(result.error ?? "", /connection lost/);
    assert.equal(transport.requests.length, 1);
  });

  it("handles an unexpected Codex response", async () => {
    const transport = transportWithModels([model("gpt-5.6-terra")])
      .respond("thread/start", { thread: {} });
    const result = await executor(transport).execute({
      prompt: "Implementa módulo de clientes con Supabase",
      routingDecision: routeTask({ prompt: "Implementa módulo de clientes con Supabase" }),
    });

    assert.equal(result.status, "error");
    assert.match(result.error ?? "", /valid thread ID/);
  });

  it("resolves in dry-run without creating a thread or a turn", async () => {
    const transport = transportWithModels([model("gpt-5.6-terra")]);
    const result = await executor(transport).execute({
      prompt: "Implementa módulo de clientes con Supabase",
      routingDecision: routeTask({ prompt: "Implementa módulo de clientes con Supabase" }),
      threadId: "existing-context",
      dryRun: true,
    });

    assert.equal(result.status, "dry-run");
    assert.equal(result.threadId, "existing-context");
    assert.equal(result.resolvedModel, "terra");
    assert.deepEqual(transport.requests.map((request) => request.method), ["model/list"]);
  });

  it("creates a thread, starts a turn, and returns its completed state", async () => {
    const transport = transportWithModels([model("gpt-5.6-terra")])
      .respond("thread/start", { thread: { id: "thread-new" } })
      .respond("turn/start", (params: JsonRecord, fake: FakeTransport) => {
        fake.emit({
          method: "turn/completed",
          params: {
            threadId: "thread-new",
            turn: { id: "turn-1", status: "completed", durationMs: 14 },
          },
        });
        assert.equal(params.model, "gpt-5.6-terra");
        assert.equal(params.effort, "medium");
        return { turn: { id: "turn-1", status: "inProgress" } };
      });
    const result = await executor(transport).execute({
      prompt: "Implementa módulo de clientes con Supabase",
      routingDecision: routeTask({ prompt: "Implementa módulo de clientes con Supabase" }),
    });

    const { taskExecution, ...executionResult } = result;
    assert.deepEqual(executionResult, {
      requestedModel: "terra",
      resolvedModel: "terra",
      realModelId: "gpt-5.6-terra",
      reasoning: "medium",
      threadId: "thread-new",
      status: "completed",
      fallbackUsed: false,
      durationMs: 14,
    });
    assert.equal(taskExecution?.attempts.length, 1);
    assert.equal(taskExecution?.attempts[0]?.status, "success");
    assert.equal(taskExecution?.attempts[0]?.model.realId, "gpt-5.6-terra");
  });

  it("sends text plus multiple local and URL images in the documented App Server format", async () => {
    const transport = transportWithModels([model("gpt-5.6-luna")])
      .respond("thread/start", { thread: { id: "thread-images" } })
      .respond("turn/start", (params: JsonRecord) => {
        assert.deepEqual(params.input, [
          { type: "text", text: "Cambia el login" },
          { type: "localImage", path: "C:\\workspace\\login.png" },
          { type: "image", url: "https://example.com/reference.jpg", detail: "high" },
        ]);
        return { turn: { id: "turn-images", status: "completed", durationMs: 2 } };
      });
    const result = await executor(transport).execute({
      prompt: "Cambia el login", routingDecision: routeTask({ prompt: "Cambia el login", hasVisualContext: true }),
      attachments: [
        { type: "image", name: "login.png", mimeType: "image/png", path: "C:\\workspace\\login.png" },
        { type: "image", name: "reference.jpg", mimeType: "image/jpeg", url: "https://example.com/reference.jpg", detail: "high" },
      ],
    });
    assert.equal(result.status, "completed");
  });

  it("continues a supplied thread when executing a turn", async () => {
    const transport = transportWithModels([model("gpt-5.6-luna")])
      .respond("thread/resume", { thread: { id: "thread-existing" } })
      .respond("turn/start", { turn: { id: "turn-2", status: "completed", durationMs: 3 } });
    const result = await executor(transport).execute({
      prompt: "Cambia el padding del navbar",
      routingDecision: routeTask({ prompt: "Cambia el padding del navbar" }),
      threadId: "thread-existing",
    });

    assert.equal(result.status, "completed");
    assert.equal(result.threadId, "thread-existing");
    assert.equal(result.taskExecution?.attempts[0]?.threadId, "thread-existing");
    assert.deepEqual(transport.requests.map((request) => request.method), [
      "model/list",
      "thread/resume",
      "turn/start",
    ]);
  });
});
