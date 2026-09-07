#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [command, ...args] = process.argv.slice(2);
const entry = command === "mcp" ? join(root, "src", "mcp", "server.ts") : join(root, "src", "cli", "main.ts");
const child = spawn(process.execPath, ["--experimental-strip-types", entry, ...(command === "mcp" ? args : process.argv.slice(2))], { stdio: "inherit" });
child.on("error", (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
