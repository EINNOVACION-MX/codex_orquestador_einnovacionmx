import { CodexAdapter } from "../codex/adapter.ts";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { InteractiveSession } from "./interactive-session.ts";
import { CliApplication } from "./app.ts";
import { loadCliConfig } from "./config.ts";
import { parseCliArgs } from "./parse.ts";
import { formatHelp, formatVersion } from "./identity.ts";
import { supportsTerminalTui, TerminalTui } from "./tui.ts";

export async function main(args = process.argv.slice(2), cwd = process.cwd()): Promise<number> {
  try {
    const options = parseCliArgs(args, loadCliConfig(cwd));
    if (options.command === "version") { process.stdout.write(`${formatVersion()}\n`); return 0; }
    if (options.command === "help") { process.stdout.write(`${formatHelp()}\n`); return 0; }
    const adapter = await CodexAdapter.connect();
    try {
      if (options.command === "interactive") {
        if (supportsTerminalTui()) {
          await new TerminalTui(adapter, cwd, { profile: options.profile, dryRun: options.dryRun }).run();
          return 0;
        }
        const interactiveTerminal = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
        const terminal = interactiveTerminal as ReturnType<typeof createInterface>;
        terminal.on("SIGINT", () => { void session.interrupt(); });
        const session = new InteractiveSession(adapter, { write: (text) => process.stdout.write(`${text}\n`), clear: () => console.clear() }, cwd, { profile: options.profile, dryRun: options.dryRun });
        await session.start();
        try {
          if (process.stdin.isTTY) {
            while (true) {
              const line = await terminal.question("> ");
              if (await session.handle(line) === "exit") break;
            }
          } else {
            for await (const line of terminal) if (await session.handle(line) === "exit") break;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ERR_USE_AFTER_CLOSE") process.stderr.write(`${error instanceof Error ? error.message : "Session stopped."}\n`);
        } finally { terminal.close(); }
        return 0;
      }
      const response = await new CliApplication(adapter).run(options);
      if (response.stdout) process.stdout.write(`${response.stdout}\n`);
      if (response.stderr) process.stderr.write(`${response.stderr}\n`);
      return response.exitCode;
    } finally { await adapter.close(); }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Unable to start Codex App Server."}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; });
}
