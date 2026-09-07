---
name: cx-native-mode
description: Delegate explicitly requested CX Auto Model work through the installed CX Native Bridge.
---

# CX Native Mode

Use CX only when the user explicitly asks to use CX, Auto Model, or this workflow is already delegated to CX. Delegate directly; do not first solve the full task in the host thread.

- For an execution request, call `cx_execute` with the task text and report its compact result.
- For visual work, pass image paths or HTTPS URLs only when the user supplied an accessible reference. Native chat attachments are not automatically available to MCP.
- For model-selection questions without execution, call `cx_route` only.
- For quota or budget, call `cx_status` only.
- For project recognition or shared context, call `cx_project` or `cx_context` only.

CX uses its own execution thread. It is separate from the host Codex thread. Do not claim that CX changes the host model or intercepts ordinary prompts automatically.

CX capabilities: execute with Auto Model, route only, status, project, context.
