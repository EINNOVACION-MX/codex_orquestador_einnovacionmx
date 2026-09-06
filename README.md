# Codex Auto Model Router

Router determinista para elegir Luna, Terra, Sol o Astra y el nivel de razonamiento apropiado antes de enviar una tarea a Codex.

Está pensado para priorizar el uso eficiente de ChatGPT Plus: Terra resuelve la implementación cotidiana; Luna absorbe trabajo mecánico; Sol y Astra se reservan para problemas que justifican su consumo.

## Estado

Las fases 1 y 2 están implementadas: clasificación, política de selección, perfiles de presupuesto, descubrimiento dinámico de modelos, threads y ejecución mediante Codex App Server.

## Instalación

Requiere Node.js 22 o posterior.

```powershell
npm install
```

## Validación

```powershell
npm test
npm run build
```

## Uso desde código

```ts
import { routeTask } from "./src/index.ts";

const decision = routeTask({
  prompt: "Implementa módulo de clientes con Supabase",
});

console.log(decision);
// {
//   domain: "crm",
//   taskType: "feature",
//   complexity: 5,
//   risk: 3,
//   selectedModel: "terra",
//   reasoning: "medium",
//   confidence: 0.96,
//   reasons: ["feature full-stack", "database modification", ...]
// }
```

## Ejecución con Codex

Codex debe estar instalado y autenticado en el entorno de ejecución. `CodexAdapter` se comunica con `codex app-server` por JSON-RPC en `stdio`; no usa una clave de API separada.

```ts
import { CodexAdapter, routeTask } from "./src/index.ts";

const prompt = "Implementa módulo de clientes con Supabase";
const adapter = await CodexAdapter.connect();

try {
  const result = await adapter.execute({
    prompt,
    routingDecision: routeTask({ prompt }),
    dryRun: true,
  });
  console.log(result);
} finally {
  await adapter.close();
}
```

Quita `dryRun` para crear o continuar un thread y ejecutar el turn. El resultado contiene `requestedModel`, `resolvedModel`, `reasoning`, `threadId`, `status`, `fallbackUsed`, `durationMs` y, cuando corresponde, `error`. Usa `minimumModel: "sol"` para bloquear degradaciones por debajo de Sol.

Los perfiles disponibles son `economy`, `balanced` y `quality`:

```ts
routeTask({
  prompt: "Analiza race condition en pagos",
  budgetProfile: "economy",
});
// Terra/high: conserva consumo para una cuenta Plus.
```

Consulta [ARCHITECTURE.md](ARCHITECTURE.md) para decisiones de diseño y [la guía de planificación](outputs/guia-auto-model-codex.md) para la futura integración con Codex App Server.
