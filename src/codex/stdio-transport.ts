import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { win32 } from "node:path";
import type {
  CodexNotification,
  CodexNotificationListener,
  CodexTransport,
  JsonRecord,
} from "./types.ts";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

interface JsonRpcEnvelope {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: { message?: unknown; code?: unknown };
}

export interface CodexStdioTransportOptions {
  command?: string;
  args?: string[];
}

export class CodexTransportError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CodexTransportError";
  }
}

/** Preserve the caller environment and supply only the Windows HOME fallback Codex needs. */
export function codexChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  if (process.platform !== "win32" || env.HOME || !env.USERPROFILE) return env;
  env.HOME = env.USERPROFILE;
  const parsed = win32.parse(env.USERPROFILE);
  if (!env.HOMEDRIVE && parsed.root) env.HOMEDRIVE = parsed.root.replace(/\\$/, "");
  if (!env.HOMEPATH && parsed.root) env.HOMEPATH = env.USERPROFILE.slice(parsed.root.length).replace(/\//g, "\\").replace(/^/, "\\");
  return env;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON-RPC 2.0 transport for the official `codex app-server` stdio protocol. */
export class CodexStdioTransport implements CodexTransport {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<CodexNotificationListener>();
  private nextRequestId = 1;
  private closed = false;
  private stderr = "";

  private constructor(process: ChildProcessWithoutNullStreams) {
    this.process = process;
    const output = createInterface({ input: process.stdout });
    output.on("line", (line) => this.handleLine(line));
    process.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-4000);
    });
    process.on("error", (error) => this.failPending(error));
    process.on("close", (code) => {
      if (!this.closed) {
        const details = this.stderr.trim();
        const suffix = details ? ` ${details}` : "";
        this.failPending(new CodexTransportError(`Codex App Server exited unexpectedly (code ${code ?? "unknown"}).${suffix}`));
      }
    });
  }

  public static async connect(
    options: CodexStdioTransportOptions = {},
  ): Promise<CodexStdioTransport> {
    const process = spawn(options.command ?? "codex", options.args ?? ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: codexChildEnvironment(),
    });
    const transport = new CodexStdioTransport(process);

    await transport.request("initialize", {
      clientInfo: {
        name: "codex-auto-model-router",
        title: "Codex Auto Model Router",
        version: "0.3.0",
      },
    });
    transport.notify("initialized", {});
    return transport;
  }

  public request<T>(method: string, params: JsonRecord | null): Promise<T> {
    if (this.closed || !this.process.stdin.writable) {
      return Promise.reject(new CodexTransportError("Codex App Server is not available."));
    }

    const id = this.nextRequestId++;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.process.stdin.write(`${message}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  public notify(method: string, params: JsonRecord): void {
    if (this.closed || !this.process.stdin.writable) return;
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  public onNotification(listener: CodexNotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failPending(new CodexTransportError("Codex transport was closed."));
    if (!this.process.killed) this.process.kill();
  }

  private handleLine(line: string): void {
    let envelope: JsonRpcEnvelope;
    try {
      envelope = JSON.parse(line) as JsonRpcEnvelope;
    } catch {
      this.failPending(new CodexTransportError("Codex App Server emitted invalid JSON-RPC output."));
      return;
    }

    if (typeof envelope.id === "number") {
      const pending = this.pending.get(envelope.id);
      if (!pending) return;
      this.pending.delete(envelope.id);
      if (envelope.error) {
        const message = typeof envelope.error.message === "string"
          ? envelope.error.message
          : "Codex App Server returned a JSON-RPC error.";
        pending.reject(new CodexTransportError(message));
        return;
      }
      pending.resolve(envelope.result);
      return;
    }

    if (typeof envelope.method === "string" && isRecord(envelope.params)) {
      const notification: CodexNotification = { method: envelope.method, params: envelope.params };
      for (const listener of this.listeners) listener(notification);
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
