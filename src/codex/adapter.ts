import { CodexModelResolver } from "./model-resolver.ts";
import { CodexStdioTransport, type CodexStdioTransportOptions } from "./stdio-transport.ts";
import { CodexThreadManager } from "./thread-manager.ts";
import { CodexTurnExecutor } from "./turn-executor.ts";
import { AutoModelOrchestrator } from "../orchestration/auto-model-orchestrator.ts";
import { CodexAppServerUsageProvider } from "../usage/codex-app-server-usage-provider.ts";
import type { UsageSnapshot } from "../budget/types.ts";
import type {
  CodexExecutionRequest,
  CodexExecutionResult,
  CodexTransport,
  DiscoveredCodexModel,
} from "./types.ts";
import type { OrchestrationRequest, OrchestrationResult } from "../orchestration/types.ts";
import type { EscalationPolicyService } from "../orchestration/types.ts";
import { CodexCapabilityRegistry } from "../capabilities/codex-capability-registry.ts";
import type { CodexCapabilitySnapshot } from "../capabilities/types.ts";

/**
 * Application-facing boundary for Codex. The classifier and router stay
 * transport-free; this adapter owns discovery, thread handling and turns.
 */
export class CodexAdapter {
  private readonly transport: CodexTransport;
  private readonly resolver: CodexModelResolver;
  private readonly threadManager: CodexThreadManager;
  private readonly executor: CodexTurnExecutor;
  private readonly usageProvider: CodexAppServerUsageProvider;

  public constructor(transport: CodexTransport) {
    this.transport = transport;
    this.resolver = new CodexModelResolver(transport);
    this.threadManager = new CodexThreadManager(transport);
    this.executor = new CodexTurnExecutor(transport, this.resolver, this.threadManager);
    this.usageProvider = new CodexAppServerUsageProvider(transport);
  }

  public static async connect(options?: CodexStdioTransportOptions): Promise<CodexAdapter> {
    return new CodexAdapter(await CodexStdioTransport.connect(options));
  }

  public discoverModels(): Promise<DiscoveredCodexModel[]> {
    return this.resolver.discover();
  }

  /** Public App Server discovery only; it never creates a thread or starts a turn. */
  public requestCapability<T>(method: string, params: import("./types.ts").JsonRecord): Promise<T> {
    return this.transport.request<T>(method, params);
  }

  public discoverCapabilities(cwd?: string): Promise<CodexCapabilitySnapshot> {
    return new CodexCapabilityRegistry(this).discover(cwd);
  }

  public execute(input: CodexExecutionRequest): Promise<CodexExecutionResult> {
    return this.executor.execute(input);
  }

  /** Reads account limits through App Server and never creates a thread or turn. */
  public getUsage(): Promise<UsageSnapshot> {
    return this.usageProvider.getUsage();
  }
  public getActiveTurn() { return this.executor.getActiveTurn(); }
  public interruptActiveTurn(): Promise<boolean> { return this.executor.interruptActiveTurn(); }

  public executeAuto(input: OrchestrationRequest, options: { policy?: EscalationPolicyService } = {}): Promise<OrchestrationResult> {
    return new AutoModelOrchestrator({
      executor: this.executor,
      ...(options.policy ? { policy: options.policy } : {}),
      usageProvider: this.usageProvider,
    }).execute(input);
  }

  public close(): Promise<void> {
    return this.transport.close();
  }
}
