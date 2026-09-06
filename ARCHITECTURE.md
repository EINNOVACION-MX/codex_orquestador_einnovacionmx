# Arquitectura

## Propósito

Codex Auto Model Router clasifica peticiones de ingeniería de forma determinista, selecciona el modelo y nivel de razonamiento adecuados, y los resuelve contra el catálogo real expuesto por Codex App Server.

## Decisiones aprobadas

- El orquestador será un cliente local sobre Codex App Server. No usa hooks para cambiar el modelo porque los hooks no exponen ese control antes del envío del turno.
- La selección inicia con reglas locales explicables. Un clasificador LLM podrá añadirse más adelante únicamente para casos de baja confianza.
- El modelo y el riesgo son dimensiones independientes. El modelo resuelve complejidad; el riesgo se convertirá después en sandbox, acceso de red y aprobación.
- Terra es el constructor principal para una cuenta ChatGPT Plus. Luna cubre cambios aislados; Sol se reserva para razonamiento difícil; Astra requiere un caso extremo y evidencia de escalamiento.
- Los nombres lógicos permanecen separados de los IDs reales de Codex. Antes de cada ejecución, el adaptador consulta `model/list` y solo elige modelos disponibles.

## Componentes

```text
src/classifier.ts  → extrae dominio, tipo, complejidad, riesgo y señales
src/router.ts      → aplica la política de presupuesto y decide modelo/reasoning
src/config.ts      → modelos, compatibilidad de reasoning y perfiles de presupuesto
src/types.ts       → contrato público tipado
```

`routeTask()` es una frontera pública pura: no escribe archivos, no realiza peticiones de red y no llama modelos. Esto permite probar las reglas de decisión sin coste ni dependencia externa.

## Política actual

| Complejidad | Modelo | Reasoning |
|---:|---|---|
| 1–2 | Luna | low |
| 3–5 | Terra | medium |
| 6–8 | Sol | high |
| 9–10 | Astra | xhigh |

El perfil `balanced` permite Astra solo cuando el problema es crítico, pertenece a arquitectura o ciberseguridad y ya fallaron dos intentos. `economy` limita la selección automática a Terra. `quality` permite Astra para complejidad extrema.

## Integración con Codex App Server

```text
TaskClassifier → ModelRouter → CodexModelResolver → CodexThreadManager → CodexTurnExecutor
```

`CodexAdapter` es la frontera de integración. Inicia el proceso oficial `codex app-server` y usa JSON-RPC 2.0 por `stdio`: `initialize`, `initialized`, `model/list`, `thread/start` o `thread/resume`, `turn/start` y la notificación `turn/completed`.

El resolver traduce el nombre lógico (`luna`, `terra`, `sol`, `astra`) al ID real detectado y escoge el nivel de reasoning más alto que sea compatible sin superar el solicitado. El clasificador no conoce transportes ni IDs de modelos.

El fallback sigue: Astra → Sol → Terra → Luna; Sol → Terra → Luna; Terra → Luna. `minimumModel` elimina las degradaciones inferiores antes de resolver. Si, por ejemplo, una auditoría exige Sol y Sol no está disponible, el resultado es `not-executed`: no inicia thread ni turn.

Con `dryRun: true`, el adaptador clasifica, enruta, descubre y resuelve modelos, pero no crea, reanuda ni ejecuta threads. Un `threadId` suministrado se reanuda con `thread/resume` en una ejecución real, conservando el contexto para una política de escalamiento futura.
