import type { CodexTransport, CodexThreadResponse, ManagedThread } from "./types.ts";

function threadIdFrom(response: CodexThreadResponse): string {
  if (!response.thread || typeof response.thread.id !== "string" || response.thread.id.length === 0) {
    throw new Error("Codex returned a thread response without a valid thread ID.");
  }
  return response.thread.id;
}

export class CodexThreadManager {
  private readonly transport: CodexTransport;

  public constructor(transport: CodexTransport) {
    this.transport = transport;
  }

  public async getOrCreate(input: {
    threadId?: string;
    realModelId: string;
  }): Promise<ManagedThread> {
    if (input.threadId) {
      const response = await this.transport.request<CodexThreadResponse>("thread/resume", {
        threadId: input.threadId,
        model: input.realModelId,
      });
      return { threadId: threadIdFrom(response), created: false };
    }

    const response = await this.transport.request<CodexThreadResponse>("thread/start", {
      model: input.realModelId,
      serviceName: "codex-auto-model-router",
    });
    return { threadId: threadIdFrom(response), created: true };
  }
}
