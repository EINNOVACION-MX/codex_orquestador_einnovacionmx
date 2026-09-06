import { CodexModelResolver } from "./model-resolver.ts";
import { CodexStdioTransport, type CodexStdioTransportOptions } from "./stdio-transport.ts";
import { CodexThreadManager } from "./thread-manager.ts";
import { CodexTurnExecutor } from "./turn-executor.ts";
import { AutoModelOrchestrator } from "../orchestration/auto-model-orchestrator.ts";
import type {
  CodexExecutionRequest,
  CodexExecutionResult,
  CodexTransport,
  DiscoveredCodexModel,
} from "./types.ts";
import type { OrchestrationRequest, OrchestrationResult } from "../orchestration/types.ts";

/**
 * Application-facing boundary for Codex. The classifier and router stay
 * transport-free; this adapter owns discovery, thread handling and turns.
 */
export class CodexAdapter {
  private readonly transport: CodexTransport;
  private readonly resolver: CodexModelResolver;
  private readonly threadManager: CodexThreadManager;
  private readonly executor: CodexTurnExecutor;

  public constructor(transport: CodexTransport) {
    this.transport = transport;
    this.resolver = new CodexModelResolver(transport);
    this.threadManager = new CodexThreadManager(transport);
    this.executor = new CodexTurnExecutor(transport, this.resolver, this.threadManager);
  }

  public static async connect(options?: CodexStdioTransportOptions): Promise<CodexAdapter> {
    return new CodexAdapter(await CodexStdioTransport.connect(options));
  }

  public discoverModels(): Promise<DiscoveredCodexModel[]> {
    return this.resolver.discover();
  }

  public execute(input: CodexExecutionRequest): Promise<CodexExecutionResult> {
    return this.executor.execute(input);
  }

  public executeAuto(input: OrchestrationRequest): Promise<OrchestrationResult> {
    return new AutoModelOrchestrator(this.executor).execute(input);
  }

  public close(): Promise<void> {
    return this.transport.close();
  }
}
