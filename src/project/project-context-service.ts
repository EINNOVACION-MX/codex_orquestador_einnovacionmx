import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { PROJECT_SCHEMA_VERSION, type ProjectContext, type ProjectContextEnvelope, type ProjectMetadata, type ProjectSnapshot, type ProjectState, type ProjectThreads } from "./types.ts";

const ignored = /(^|[\\/])(?:node_modules|dist|build|\.git|\.env(?:\..*)?|secrets?|credentials?|.*\.pem|.*\.key)([\\/]|$)/i;
function now() { return new Date().toISOString(); }
function git(cwd: string, args: string[]): string | undefined { try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return undefined; } }
function readJson<T>(path: string): T | undefined { try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; } }
function writeJson(path: string, value: unknown) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }

/** Project-scoped, compact context storage suitable for both CLI and future bridges. */
export class ProjectContextService {
  public open(cwd: string, force = false): ProjectSnapshot {
    const root = git(cwd, ["rev-parse", "--show-toplevel"]) ?? resolve(cwd); const dir = join(root, ".cx"); mkdirSync(dir, { recursive: true });
    const projectPath = join(dir, "project.json"), contextPath = join(dir, "context.json"), threadsPath = join(dir, "threads.json"), statePath = join(dir, "state.json");
    const commit = git(root, ["rev-parse", "HEAD"]); const working = this.workingTree(root);
    let metadata = readJson<ProjectMetadata>(projectPath); let context = readJson<ProjectContext>(contextPath); let state = readJson<ProjectState>(statePath);
    const changed = force || !metadata || !context || !state || state.lastIndexedCommit !== commit || state.lastWorkingTree !== working;
    if (!metadata || metadata.schemaVersion !== PROJECT_SCHEMA_VERSION) metadata = { schemaVersion: PROJECT_SCHEMA_VERSION, projectId: createHash("sha256").update(root).digest("hex").slice(0, 16), name: basename(root), rootPath: root, initializedAt: now(), lastOpenedAt: now(), ...(commit ? { repository: { root, lastIndexedCommit: commit } } : {}) };
    metadata.lastOpenedAt = now();
    if (changed) context = this.index(root);
    state = { schemaVersion: PROJECT_SCHEMA_VERSION, ...(commit ? { lastIndexedCommit: commit } : {}), lastWorkingTree: working };
    const threads = readJson<ProjectThreads>(threadsPath) ?? { schemaVersion: PROJECT_SCHEMA_VERSION, threads: [] };
    writeJson(projectPath, metadata); writeJson(contextPath, context); writeJson(statePath, state); writeJson(threadsPath, threads);
    return { metadata, context: context!, threads, state, reindexed: changed };
  }
  public saveThreads(root: string, threads: ProjectThreads) { writeJson(join(root, ".cx", "threads.json"), threads); }
  public envelope(snapshot: ProjectSnapshot): ProjectContextEnvelope {
    const c = snapshot.context;
    return { projectId: snapshot.metadata.projectId, projectName: snapshot.metadata.name, stack: c.stack.slice(0, 12), ...(c.architecture ? { architectureSummary: c.architecture.slice(0, 300) } : {}), importantModules: c.importantModules.slice(0, 12), ...(c.database ? { databaseSummary: c.database.slice(0, 200) } : {}), integrations: c.integrations.slice(0, 8), conventions: c.conventions.slice(0, 8), commands: Object.keys(c.commands).slice(0, 12), constraints: c.constraints.slice(0, 8), knownDecisions: c.knownDecisions.slice(0, 8), agentsInstructionsAvailable: c.conventions.includes("AGENTS.md instructions apply"), currentGitState: snapshot.state.lastWorkingTree ? "dirty" : "clean" };
  }
  public prompt(envelope: ProjectContextEnvelope, prompt: string): string { return `[CX project context: ${JSON.stringify(envelope)}]\nTask: ${prompt}`; }
  private index(root: string): ProjectContext {
    const files = readdirSync(root).filter((name) => !ignored.test(name)); const packageJson = readJson<{ scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(join(root, "package.json"));
    const readme = existsSync(join(root, "README.md")); const agents = existsSync(join(root, "AGENTS.md"));
    const deps = Object.keys({ ...(packageJson?.dependencies ?? {}), ...(packageJson?.devDependencies ?? {}) });
    return { schemaVersion: PROJECT_SCHEMA_VERSION, architecture: readme ? "README-guided project" : "Lightweight project scan", stack: deps.slice(0, 20), importantModules: files.filter((f) => /^(src|app|pages|lib|api|prisma|database)$/i.test(f)), integrations: deps.filter((d) => /supabase|stripe|firebase|openai|n8n/i.test(d)), conventions: agents ? ["AGENTS.md instructions apply"] : [], commands: packageJson?.scripts ?? {}, constraints: ["Secrets and dependency/build directories are excluded."], knownDecisions: [], contextUpdatedAt: now() };
  }
  private workingTree(root: string): string {
    return (git(root, ["status", "--porcelain"]) ?? "").split("\n").filter((line) => !line.slice(3).replace(/\\/g, "/").startsWith(".cx/")).join("\n");
  }
}
