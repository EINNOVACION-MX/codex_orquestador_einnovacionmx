# Codex Auto Model Router

Router determinista para elegir Luna, Terra, Sol o Astra y el nivel de razonamiento apropiado antes de enviar una tarea a Codex.

Está pensado para priorizar el uso eficiente de ChatGPT Plus: Terra resuelve la implementación cotidiana; Luna absorbe trabajo mecánico; Sol y Astra se reservan para problemas que justifican su consumo.

## Estado

Las fases 1 y 2 están implementadas: clasificación, política de selección, perfiles de presupuesto, descubrimiento dinámico de modelos, threads y ejecución mediante Codex App Server.

## Instalación

Requiere Node.js 22 o posterior.

```powershell
npm install
npm run build
npm link
```

## CLI AUTO

Después de `npm link`, usa el router directamente:

```powershell
cx "Cambia el padding del navbar"
cx "Implementa módulo de clientes con Supabase" --dry-run
cx "Replica este login" --image .\referencias\login.png --dry-run
cx status
```

La CLI usa `auto` por defecto. Puedes imponer un techo de consumo con `--profile conservative|eco|emergency`; nunca relaja una cuota real más restrictiva. También admite `--json`, `--model luna|terra|sol|astra`, `--reasoning <level>` y `--no-escalation`.

### Referencias visuales

Usa `--image` o `-i` una o varias veces para aportar PNG, JPEG, WebP o GIF del proyecto. Las referencias se validan antes de ejecutar: deben estar dentro del workspace, usar una extensión permitida, pesar hasta 10 MB y no pueden ser `.env`, claves ni rutas sensibles. También se admiten URLs HTTPS desde las herramientas MCP. Los archivos se envían a Codex como `localImage` y nunca se guardan en `.cx` ni se serializan en la salida JSON.

En modo interactivo, `/image ruta.png` prepara una imagen para el siguiente mensaje, `/images` lista las pendientes y `/images clear` las descarta. Tras enviar correctamente el siguiente mensaje, la lista se limpia.

Un archivo opcional `.cxrc` puede contener:

```ini
profile = auto
output = human
dryRun = false
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

## Codex Native Bridge

Codex puede cargar el plugin local desde [`.agents/plugins/marketplace.json`](.agents/plugins/marketplace.json). El plugin inicia `cx mcp` bajo demanda y expone `cx_route`, `cx_execute`, `cx_status`, `cx_project` y `cx_context`. Las herramientas comparten el mismo `ProjectContextService` y `.cx` que la CLI.

```powershell
codex plugin marketplace add "C:\ruta\al\Orquestador_Codex"
codex plugin add cx-native-bridge@cx-local
```

En Codex Desktop, agrega el marketplace local, instala **CX Native Bridge** y actívalo desde **Sources → Use plugins** en un task. La integración es explícita: no intercepta prompts normales ni puede cambiar el modelo del turno anfitrión. `cx_execute` crea su propio turn mediante el App Server con la decisión de CX.

### Native CX Mode

Dentro de un task con el plugin activado, pide explícitamente: “Usa CX para implementar recuperación de contraseña”. Para consultar la selección sin ejecutar: “Con CX, ¿qué modelo usarías para esto?”. Para cuota, proyecto o contexto: “Muéstrame mi cuota de CX”, “¿Qué proyecto reconoce CX?” o “Muéstrame el contexto resumido de CX”.

CX delega directamente mediante `cx_execute`; el hilo del task nativo permanece separado del thread interno que CX conserva en `.cx/threads.json`. Los resultados muestran proyecto, tipo de tarea, modelo y reasoning, presupuesto, intentos, escalaciones, estado, resumen y el thread interno cuando corresponde.

Las herramientas `cx_route` y `cx_execute` aceptan un arreglo `images` con rutas de imágenes dentro del workspace o URLs HTTPS. Los adjuntos cargados directamente en el chat nativo no se transfieren automáticamente al MCP: indica una ruta o URL accesible de forma explícita.
