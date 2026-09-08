export const CX_IDENTITY = {
  name: "CX Auto Model Orchestrator",
  description: "Auto Model Orchestrator for OpenAI Codex",
  version: "0.3.0",
  developer: "EINNOVACION MX",
  license: "MIT",
  repository: "https://github.com/EINNOVACION-MX/codex_orquestador_einnovacionmx",
} as const;

export function formatVersion(): string {
  return `${CX_IDENTITY.name} ${CX_IDENTITY.version}`;
}

export function formatHelp(): string {
  return [
    formatVersion(),
    CX_IDENTITY.description,
    "",
    "Usage:",
    '  cx "<prompt>" [options]',
    "  cx status [--json]",
    "  cx                 Start interactive mode",
    "",
    "Options:",
    "  --dry-run              Route without creating a turn",
    "  --json                 Emit structured output",
    "  --image, -i <path>     Attach a workspace image (repeatable)",
    "  --profile <profile>    auto, balanced, conservative, eco, emergency",
    "  --model <model>        luna, terra, sol, astra",
    "  --reasoning <level>    Set compatible reasoning",
    "  --no-escalation        Prevent model escalation",
    "  --version, -v          Show version",
    "  --help, -h             Show this help",
  ].join("\n");
}

export function formatAbout(): string {
  return [
    CX_IDENTITY.name,
    `Version: ${CX_IDENTITY.version}`,
    "",
    CX_IDENTITY.description,
    `Developed by ${CX_IDENTITY.developer}`,
    "Open Source",
    `Repository: ${CX_IDENTITY.repository}`,
    `License: ${CX_IDENTITY.license}`,
    "",
    "CX is an independent tool for Codex. It is not an official OpenAI product or affiliate.",
  ].join("\n");
}
