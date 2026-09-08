# CX Auto Model Orchestrator

**Auto Model Orchestrator for OpenAI Codex**
Developed by **EINNOVACION MX**

CX is an independent, open source CLI that classifies engineering tasks, selects a suitable Codex model and reasoning level, and applies usage-aware execution controls.

## What it does

CX routes tasks deterministically before execution. Luna handles small mechanical changes, Terra is the primary builder, and Sol or Astra are reserved for work that merits their extra reasoning cost.

## Features

- Deterministic task classification and model routing.
- Dynamic discovery of models and compatible reasoning through Codex App Server.
- Usage-aware budget controls, fallback protection and escalation policy.
- Persistent, compact project context in local `.cx` state.
- CLI, interactive mode, native Codex MCP bridge and image references.
- Transcript-first terminal UI with real scroll, follow mode, compact status and progressive agent output.
- Slash command palette, dynamic App Server capability discovery and CX agent constraints.

## Requirements

- Node.js 22 or later.
- Codex CLI installed and authenticated for model discovery or execution.

## Installation

```powershell
npm install
npm run build
npm link
```

`private: true` remains enabled to prevent accidental npm publication. Remove it only when a deliberate publishing process is ready.

## CLI Usage

```powershell
cx "Cambia el padding del navbar"
cx "Implementa módulo de clientes con Supabase" --dry-run
cx "Replica este login" --image .\references\login.png --dry-run
cx status
cx --version
cx --help
```

The default is AUTO. Optional overrides are `--profile conservative|eco|emergency`, `--model luna|terra|sol|astra`, `--reasoning <level>` and `--no-escalation`. Use `--json` for stable automation output; it never includes startup branding in stdout.

An optional `.cxrc` can define defaults:

```ini
profile = auto
output = human
dryRun = false
```

## Interactive Mode

Run `cx` without arguments. In a capable terminal, CX opens a transcript-first `blessed` TUI: the conversation occupies the terminal, the input remains fixed at the bottom, and the compact status bar remains at the top. In non-TTY or `TERM=dumb` environments it keeps the compatible plain-text session. Commands include:

```text
/about
/status
/image <path>
/images
/images clear
/project
/context
/threads
/agents
/skills
/plugins
/mcp
/tools
/model
/reasoning
/profile
/new
/exit
```

`/about` displays the project identity, version, license, repository and independence notice.
Type `/` to open the terminal command palette; type a prefix such as `/ag` to filter it, then use arrows, Enter, Tab and Esc to navigate it. CX Agents add project-scoped routing constraints while AUTO still selects the model; the Security and Architecture agents require Sol or Astra.

### Transcript navigation

The transcript retains every interaction in the current session. Use the mouse wheel, PageUp/PageDown, Home/End, or Ctrl+Up/Ctrl+Down to read it. While viewing the latest output, CX follows new content automatically. If you scroll upward, CX preserves your position and shows `↓ New output` until you return to the end.

The slash palette appears above the input instead of replacing the transcript. Press **F2** to toggle the detailed status panel; `/status` remains the full text status command. Progressive App Server message deltas update one CX transcript entry, while concise activity, retry, escalation, warning and completion events remain visible in sequence.

## Codex Native Bridge

The local plugin exposes `cx_route`, `cx_execute`, `cx_status`, `cx_project`, `cx_context`, `cx_capabilities` and `cx_agents` through MCP and shares the same project state as the CLI.

```powershell
codex plugin marketplace add "C:\ruta\al\Orquestador_Codex"
codex plugin add cx-native-bridge@cx-local
```

Enable **CX Native Bridge** in Codex Desktop through **Sources → Use plugins**. The integration is explicit: it does not intercept ordinary prompts or change the host turn model. `cx_execute` creates its own App Server turn using CX's decision.

## Multimodal Usage

Use `--image` or `-i` repeatedly for workspace PNG, JPEG, WebP or GIF references, each up to 10 MB. MCP tools also accept HTTPS image URLs. CX sends them to Codex App Server as `localImage` or `image` inputs alongside text.

Images must be inside the workspace; `.env`, credential-like paths, private keys and unsupported formats are rejected. Image bytes and base64 payloads are never stored in `.cx` or emitted by CLI JSON. Native chat attachments are not automatically available to MCP: pass an accessible path or HTTPS URL explicitly.

## Architecture

The core flow is:

```text
TaskClassifier → ModelRouter → BudgetController → Codex Adapter → Codex App Server
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the implementation decisions and boundaries.

## Security

`.cx/`, `.env` and `.env.*` are ignored by Git. The project context excludes secrets, credentials, private keys, dependencies and generated directories. Before publishing, run the test suite and inspect `git status` to confirm that no local state or credentials are staged.

## Open Source

The repository is prepared for GitHub at [EINNOVACION-MX/codex_orquestador_einnovacionmx](https://github.com/EINNOVACION-MX/codex_orquestador_einnovacionmx). It is licensed under [MIT](LICENSE). Review release metadata and remove `private: true` only when publication is intentional.

## Disclaimer

CX Auto Model Orchestrator is an independent project developed by EINNOVACION MX. OpenAI and Codex are trademarks and products of their respective owners. CX is not an official OpenAI product, is not affiliated with OpenAI, and is not developed by OpenAI.
