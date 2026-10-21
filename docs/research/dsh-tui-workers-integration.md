# Integración de Agent Workers en el side panel de dsh-tui

**Fecha:** 2026-10-21  
**Ámbito:** `dsh-workers` 0.3.6 (`/home/cesardiaz/projects/dsh-workers`) y `dsh-tui` 0.16.1 (paquete instalado en `/home/cesardiaz/.volta/.../@deepseek-harness-tui/dsh-tui`).  
**Método:** lectura estática de código, configuración y estado real. No se modificó el repositorio ni se lanzaron jobs.

---

## 1. Resumen ejecutivo

**Recomendación: opción D.** Un plugin nativo de dsh-tui que:

1. **Lee** el *state dir* de dsh-workers directamente (`job.json`, `events.ndjson`, `final.md`), igual que ya hacen el pane de Claude Code y el dashboard. Es barato, sobrevive a reinicios del MCP y funciona aunque no haya ningún servidor de control vivo.
2. **Actúa** contra un **control HTTP loopback embebido en el mismo proceso MCP que posee el `JobManager`**. Ese servidor comparte memoria con los jobs (handles de proceso, cola, locks, session locks) y es el único que puede cancelar, hacer steer, cleanup o delete de forma segura.
3. **Nunca** instancia un `JobManager` ni lanza un segundo `server.mjs`: arrancar otro manager sobre el mismo state dir marca los jobs vivos como `interrupted` y puede matar sus process groups (`src/jobs.ts:392-427`).

La opción A sola no sirve para escribir; la B (hablar MCP directamente) no es posible con el transporte actual stdio y un segundo servidor es peligroso; la C (webview/iframe) no existe en dsh-tui, que es una TUI Ink sin motor HTML. El panel nativo sí es viable: dsh-tui 0.16.1 expone `ctx.tuiPanels` (experimental, API v1) y los plugins son ESM en proceso con acceso completo a Node (`fs`, `http`, `fetch`).

**Dos hallazgos que condicionan el diseño** (detalle en §6):

- El arranque de un segundo MCP server **interrumpe jobs vivos de otro owner**. Antes de exponer acciones hay que añadir *leases* de owner y hacer que la recuperación ignore jobs cuyo owner sigue vivo.
- Un job terminal puede compartir worktree con un job activo creado por `dsh_steer`; hoy `cleanup`/`delete` del original **borrarían el worktree que el nuevo job está usando**. El panel debe bloquearlo y conviene añadir la guarda en el servidor.

---

## 2. Qué existe hoy (evidencia)

### 2.1 Modelo de job y state dir

Cada job es un proceso `dsh --profile <profile> --json` independiente, con salida NDJSON. El `JobManager` mantiene en memoria la cola FIFO, los procesos hijos, los locks de escritura y de sesión (`src/jobs.ts:266-293`). Los límites por defecto son 3 concurrentes y 16 en cola (`src/config.ts:182-200`).

Por job, en `<stateDir>/jobs/<job_id>/`:

| Fichero | Contenido | Escritura |
|---|---|---|
| `job.json` | Estado persistido en camelCase: identidad, estado, tiempos, perfil/provider/model, acceso/aislamiento, worktree, usage, coste, alerts, contadores, `stderrTail`, rutas | atómica (tmp + rename), `src/jobs.ts:1361-1370` |
| `events.ndjson` | Eventos NDJSON de DSH, una línea por evento, append | `createWriteStream` con `flags:'a'`, `src/jobs.ts:768-778` |
| `final.md` | Respuesta final del worker, escrita al cerrar | `writeFile`, `src/jobs.ts:821-827` |
| `stderr.log` | **Declarado pero nunca escrito** | `stderrPath` se persiste (`src/jobs.ts:652`) pero no hay writer; el pane usa `job.json.stderrTail` |

**Desajuste de `cleaned`:** `persisted()` escribe `cleaned` en el nivel superior (`src/jobs.ts:207`), pero el pane y el dashboard leen `worktree.cleaned` (`hooks/jobs.ts:109-123`, `src/dashboard.ts:170-180`). Hay jobs reales con `"cleaned": true` arriba y sin `cleaned` dentro de `worktree`. El panel debe considerar `job.cleaned === true || job.worktree.cleaned === true`; si no, seguirá ofreciendo cleanup tras limpiar.

Rutas y campos relevantes:

- Creación de rutas: `src/jobs.ts:623-655`.
- Persistencia: `persisted()` en `src/jobs.ts:169-213`; `fromPersisted()` en `215-264`.
- Resumen público: `summary()` en `src/jobs.ts:1271-1316` (`job_id`, `status`, `reason`, `profile`, `provider`, `model`, `group_id`, `group_name`, `owner_id`, `access`, `isolation`, `cwd`, `worktree`, `created_at`, `started_at`, `elapsed_s`, `queue_position`, `session_id`, `pid`, `steps`, `tool_calls`, `last_tool`, `last_event_s_ago`, `malformed_lines`, `usage`, `cost_usd`, `alerts`).
- Estados: `queued | starting | running | succeeded | failed | timed_out | cancelled | interrupted` (`src/types.ts:3-11`).
- Alertas: `stalled | loop | tool_errors | budget` (`src/types.ts:43-49`), calculadas por `src/watchdog.ts`.
- Coste: estimación por tabla de precios (`src/pricing.ts:20-69`); `undefined` si el modelo no está en la tabla.

**Hecho clave:** `job.json` no persiste la tarea (`task`), pero `events.ndjson` contiene `tool_call.input` y `tool_result.result`, que pueden incluir rutas, comandos y datos sensibles. El panel debe tratarlos como datos no confiables.

### 2.2 Pane de Claude Code

- Refresco: timer de **1000 ms** (`hooks/register.tsx:71`, `646-648`); `refresh()` lista `jobs/`, lee `job.json` solo si cambió el mtime, `events.ndjson` para jobs activos o expandidos, y `final.md` para un succeeded expandido (`hooks/register.tsx:489-595`). La lectura de eventos tiene tope de 3,5 MB y la de final de 1 MB (`hooks/jobs.ts:46-50`).
- Render: el hook `ui.render` lee solo átomos de `$.state`; no toca el filesystem en render (`hooks/register.tsx:661-1505`).
- Filtro por proyecto: worktree por `worktree.repoRoot`, resto por `cwd`; debe estar dentro del cwd de la sesión (`hooks/jobs.ts:507-513`). Límite de 30 jobs terminales; los activos nunca se recortan (`hooks/jobs.ts:38, 546-561`).
- Acciones: `copy id`, `copy branch`, `cleanup` (solo terminal con worktree no limpiado) y `delete` (solo terminal). Confirmación de doble pulsación en 5 s; si el worktree está sucio, segunda confirmación `discard & clean`/`discard & delete` (`hooks/register.tsx:287-338, 1256-1380`).
- **No ofrece `steer` ni `cancel`.** Esas acciones solo existen como tools MCP y slash commands del agente. El dashboard tampoco las ofrece.
- Las acciones llaman a `dsh_cleanup`/`dsh_delete` vía `$.mcp.call`, con resolución del nombre del servidor MCP (`hooks/register.tsx:107-198, 287-306`).

### 2.3 Dashboard HTTP/SSE

- Servidor loopback `127.0.0.1:47100` por defecto (`src/ui.ts:13-15`).
- `GET /api/jobs`, `GET /api/jobs/:id/events`, `GET /api/stream` (SSE cada 750 ms) y `DELETE /api/jobs/:id` (única escritura; solo jobs terminales) (`src/ui.ts:230-317`; `src/dashboard.ts:112-116`).
- La SSE emite snapshots `jobs` y páginas `events`; no emite `final` ni diff (`src/ui.ts:159-221`).
- El HTML permite borrar con confirmación y segundo aviso si el worktree está sucio (`src/dashboard.html:878-923`); no hay cancel/steer/cleanup.
- El README lo deja claro: “read-only except for terminal-job deletion”, “Cancellation remains an MCP operation” y “The dashboard is not the DSH TUI side panel” (`README.md:178-182, 228-231`).

### 2.4 dsh-tui 0.16.1: qué puede hacer

- **Perfil activo:** `~/.dsh/profiles/dsh-tui`; bundles `@deepseek-ai/dsh-base`, `@deepseek-harness-tui/dsh-tui`, `dsh-tui-stt`, `dsh-tui-quotas` (`package.json:4-17`). `cordis.patch.yml` solo añade providers LLM (`~/.dsh/profiles/dsh-tui/cordis.patch.yml:4-40`).
- **Plugins:** se cargan como bundles ESM en el proceso del host, con `package.json` → `dsh.bundle.patch` → `cordis.patch.yml` → fila que importa el módulo. `/plugin install <package | path | git url>` está soportado (`README.md:473-480` de dsh-tui); también se puede añadir un `link:` al perfil y reiniciar. El plugin recibe `apply(ctx, config)`.
- **Acceso a Node:** los plugins son código en proceso sin sandbox de SO. `dsh-tui-quotas` (en `/home/cesardiaz/projects/dsh-tui-plugins/dsh-tui-quotas`) lee `~/.dsh/.credentials.yaml`, usa `node:fs`, `node:http`, `fetch`, `setInterval` y registra escena/status/shortcut/command (`src/index.ts:237-341`, `src/view.ts:9-45`). El manifiesto `dsh-plugin.json` declara permisos de *host* (storage, messages, intercepts), no acceso al sistema de archivos.
- **MCP:** dsh-tui puede cargar servidores MCP para el agente vía `@deepseek-ai/dsh-mcp-client`, stdio o streamable HTTP, configurado en el patch (`guide/dsh-tui-guide/configuration.md:316-344`). Eso es para las tools del agente, no para que un panel invoque tools.
- **Side panel:** `Ctrl+B` abre una columna de paneles; los paneles de plugins se añaden automáticamente a `sidePanel.panels` (`README.md:38`; `lib/types/settings/definitions.js:270-278`). La API `ctx.tuiPanels` es **experimental** y la versión de API es 1 (`lib/types/dsh-adapter/panels.d.ts:26`).
- **Contrato del panel** (`lib/types/dsh-adapter/panels.d.ts`):
  - `register({ apiVersion: 1, id, title, icon?, minColumns?, order?, component?, compact? }, identity?)`; el host prefija `<pluginId>:` al id, presupuesto ≤4 paneles por plugin y ≤32 globales, `minColumns` 12-64 (por defecto 28), `mountPolicy:'active'` forzado (`panels.js:214-248`; `panels.d.ts:28-32`).
  - El panel recibe `{ React, ui, host, width, height, focused, visible, mode }` (`panels.d.ts:140-160`). `ui` solo expone `Box`, `Text`, `Image`, `ScrollBox`, `Divider`, `useTerminalSize`, `useAnimationTime` y `useTheme` (`panels.d.ts:45-64`). **No hay `Markdown` ni `TextInput`.**
  - `host` expone `snapshot()`, `notify()`, `clearBadge()`, `sendToChat()`, `openScene()`, `toast()`, `storage`, `onKey()`, `focus()` (`panels.d.ts:117-138`). `sendToChat` devuelve `false` en esta versión; `onKey` solo entrega eventos mientras el panel tiene foco. `ui.Box` conserva click/hover/wheel, pero no eventos de teclado/foco (`panels.d.ts:33`).
  - `open(id)` requiere el id final con prefijo; `list()` devuelve los ids propios, útil para obtenerlo tras registrar (`panels.js:295-320`). Hay rate limit de 1 apertura cada 5 s y 3 crashes deshabilitan el panel en la sesión.
  - `compact` se valida pero **no se renderiza** en esta versión.
- **Diálogos:** `ctx.tuiDialogs` ofrece `select/confirm/input`; el input está limitado a **500 celdas** (`lib/types/dsh-adapter/dialogs.d.ts:80`; `dialogs.js:37`). Un mensaje de steer de hasta 20.000 caracteres no cabe ahí.
- **Escenas:** `ctx.tuiScenes` permite una vista full-screen con el kit completo de UI (`Box/Text/useInput/useTerminalSize/...`), útil para un editor de steer o para el final completo (`lib/types/dsh-adapter/scenes.d.ts:20-30`).
- **No hay webview/iframe.** La UI es React Ink sobre terminal; la única salida gráfica es imagen Kitty/Sixel (`README.md:34`). No se puede embeber el dashboard HTML de forma interactiva.

### 2.5 MCP dsh-workers

Tools registradas en `src/server.ts:63-363`:

| Tool | Uso | Semántica |
|---|---|---|
| `dsh_start` | lanzar worker | crea job, queue/worktree, devuelve id |
| `dsh_steer` | corregir | cancela si activo y **reanuda la misma sesión DSH** con un job nuevo (`src/jobs.ts:954-1017`) |
| `dsh_status` | listar | resumen + límites |
| `dsh_group` | grupo por defecto | id/nombre de sesión padre |
| `dsh_profile` | perfil | leer/cambiar perfil para nuevos jobs |
| `dsh_wait` | esperar | long-poll acotado; no cancela |
| `dsh_result` | resultado | final + diff + stderr tail + usage |
| `dsh_events` | eventos | página por cursor |
| `dsh_cancel` | cancelar | SIGTERM, 5 s, SIGKILL al process group |
| `dsh_cleanup` | limpiar worktree | conserva el registro; dirty se preserva |
| `dsh_delete` | borrar registro | terminal; dirty exige `discard_changes` |

**Transporte: solo stdio** (`StdioServerTransport`, `src/server.ts:397`). No hay HTTP/SSE ni socket de control. Un panel no puede “engancharse” al stdio que posee Claude Code.

### 2.6 El problema de los múltiples owners

`loadPreviousJobs()` recorre **todos** los directorios de `jobs/`, no solo los del owner actual. Para cada job no terminal:

1. si el pid sigue vivo y su `pgidStartTime` coincide, llama a `killTreeByPid`;
2. marca el job como `interrupted`;
3. reescribe `job.json`.

Está en `src/jobs.ts:392-427`. Por tanto, arrancar un segundo MCP server (o cualquier proceso que instancie `JobManager`) mientras otro tiene jobs vivos **corrompe esos jobs**. En esta máquina hay varios `plugin-dist/server.mjs` y `dist/server.js` coexistiendo; hoy es “seguro” solo porque no hay jobs vivos en el momento de arrancar. El panel no debe crear un manager, y el control plane debe resolver el routing por owner.

### 2.7 Worktree compartido tras steer

`dsh_steer` crea un job nuevo con `resume_job_id`; el nuevo job hereda `worktree = original.worktree` y `cwd = worktree.path` (`src/jobs.ts:550-573`). El original queda terminal. `cleanup` y `delete` solo comprueban que el job sea terminal y que tenga worktree (`src/jobs.ts:1179-1214`); **no comprueban si otro job activo usa el mismo path**. Un `cleanup`/`delete` del original puede borrar el worktree del job steerado en marcha. Es un bug latente del pane/dashboard actual y una guarda obligatoria para el panel.

---

## 3. Evaluación de opciones

| Opción | Lectura | Acciones | Riesgo | Esfuerzo | Veredicto |
|---|---|---|---|---|---|
| **A. Panel lee state dir y escribe por MCP/CLI/socket** | Excelente (misma verdad que pane/dashboard) | MCP stdio imposible; CLI/socket requiere un canal nuevo; matar por pid se registra como fallo | Alto si se improvisa | Medio | **Solo la mitad de lectura**. La escritura termina siendo D. |
| **B. Panel habla con el MCP server (stdio o HTTP) usando tools `dsh_*`** | Tools reutilizadas | Correcto si es el mismo owner | **Muy alto** con stdio/segundo server: `loadPreviousJobs` mata jobs vivos; un panel no puede attacharse al stdio ajeno | Medio-alto | **Rechazada** en su forma actual. Viable solo con transporte HTTP MCP y routing por owner, que es más trabajo que una API REST de UI. |
| **C. Panel consume el dashboard 47100 en webview/iframe** | Dashboard ya existe | Solo DELETE; no cancel/steer/cleanup | **Imposible**: no hay webview/iframe en dsh-tui | Bajo | **Rechazada** como panel. El dashboard sigue siendo el monitor rico en navegador. |
| **D. Panel nativo + control HTTP loopback embebido en el MCP** | State dir (directo) | Owner-only, mismas funciones que el agente | Medio, controlable con leases + confirmaciones | Medio | **Recomendada.** |
| D2. Igual que D pero socket Unix/JSON-RPC | State dir | Owner-only | Menor superficie de red; más complejo en Windows y para el dashboard | Medio | Alternativa de hardening. |
| D3. Daemon singleton que posea todos los jobs; MCP servers como clientes | State dir/API | Centralizado y multi-frontend | Refactor grande de ciclo de vida, auth, perfiles y tools | Alto | Futuro, no primera entrega. |

### Por qué A no basta

- `cancel` necesita el `ChildProcess` y el `cancelReason` en memoria. Si se mata el process group desde fuera, el `close` del owner ve una señal/código distinto y lo clasifica como `failed`/`nonzero_exit` (`src/jobs.ts:857-868`), no como `cancelled`. Además puede dejar `job.json` inconsistente.
- `steer` no es “enviar un mensaje”: es cancelar y volver a lanzar `dsh --session-id` con el mismo cwd/worktree/perfil, respetando `sessionLocks`, `writeLocks`, timeout y grupo (`src/jobs.ts:954-1017`). Duplicar esa lógica fuera del manager es frágil.
- `cleanup`/`delete` sí podrían hacerse por fichero (lo hace el dashboard), pero sin comprobar owner/worktree compartido se pueden borrar jobs vivos. El dashboard lo hace solo para terminales y con confirmación; aun así tiene la carrera del worktree compartido.

### Por qué B no basta

- El servidor MCP usa `StdioServerTransport`; no hay endpoint al que conectarse.
- dsh-tui puede cargar MCP para el **agente**, pero no expone a los plugins un cliente MCP para invocar tools fuera del turno del modelo. Aunque lo hiciera, el servidor MCP configurado en dsh-tui sería un **segundo** `JobManager`.
- Un segundo manager sobre el mismo state dir ejecuta `loadPreviousJobs` y interrumpe/mata los jobs del primero.
- MCP devuelve texto JSON con `isError`, sin capacidades ni snapshots ricos; para una UI que refresca cada segundo es más directo un REST pequeño.

### Por qué C no es posible

- dsh-tui no tiene webview, iframe ni navegador embebido; renderiza celdas de terminal. `Image` permite una captura estática Kitty/Sixel, no HTML interactivo.
- El dashboard es read-only salvo DELETE y no siempre está arrancado; no emite final/diff; y su SSE está pensada para el navegador, no para un panel de acciones.
- Se puede ofrecer “abrir dashboard en el navegador” como acción auxiliar (spawn `xdg-open`/`open`/`start`), pero no como panel.

---

## 4. Arquitectura recomendada (D)

```text
Claude Code / cualquier host
  └─ MCP server dsh-workers (stdio)
       ├─ JobManager en memoria (cola, procesos, locks)
       ├─ state dir compartido
       │    ├─ jobs/<id>/{job.json,events.ndjson,final.md}
       │    └─ control/<ownerId>.json   ← descriptor + token (0600)
       └─ control HTTP 127.0.0.1:<ephemeral>  ← mismas funciones que las tools
              ▲
              │ GET health / POST acciones
DSH TUI session
  └─ plugin dsh-tui-workers
       ├─ lee state dir cada 1 s (read model)
       ├─ descubre descriptors cada 5 s
       └─ panel nativo ctx.tuiPanels (lista, detalle, acciones)
```

### Principios

1. **Filesystem = read model.** `job.json` es la fuente de verdad para lista/estado; `events.ndjson` y `final.md` para detalle. El panel funciona en modo read-only si no hay control server.
2. **Control plane = write model.** Solo el proceso que posee el `JobManager` muta jobs. El panel nunca escribe el state dir ni mata procesos.
3. **Owner routing.** Cada job tiene `ownerId`; cada servidor publica un descriptor con su `owner_id`. El panel enruta cada acción al owner vivo; si no está, deshabilita la acción.
4. **Un solo writer por worktree.** Antes de cleanup/delete, comprobar que ningún job activo comparte `worktree.path`/sesión.
5. **Acciones destructivas explícitas.** Doble confirmación, segundo aviso para dirty, y nunca en el primer press.

### Componentes nuevos en dsh-workers

| Componente | Responsabilidad |
|---|---|
| `src/control/protocol.ts` | Tipos, esquemas zod, códigos de error, versión `dsh-workers-control/1` |
| `src/control/descriptor.ts` | Crear/leer/prune descriptors atómicos en `<state>/control/<ownerId>.json`; token; pid/pid_start; health |
| `src/control/server.ts` | HTTP loopback, auth bearer, rutas, límites de body, timeouts, SSE opcional |
| `src/control/service.ts` | Adaptador `ControlBackend` sobre `JobManager`; DTOs, capacidades, owner checks, errores |
| `src/control/client.ts` | Cliente tipado para tests/CLI; el panel puede usar `fetch` |
| `src/owner-lease.ts` | Lease de owner para que `loadPreviousJobs` no toque jobs de owners vivos |

### Arranque

1. Crear `state/control` (0700) y generar token.
2. Bind del control server a `127.0.0.1:0`, escribir descriptor con `ready:false`.
3. `manager.init()`; la recuperación lee los descriptors/leases vivos y **salta** los jobs no terminales de otros owners vivos.
4. Marcar `ready:true` en el descriptor y en `/v1/health`.
5. En `SIGTERM/SIGINT/stdin end`: `ready:false`, cerrar server, borrar descriptor, `manager.shutdown()`.

Si el control server no puede arrancar (FS read-only, puerto, etc.), el MCP sigue funcionando y el panel cae a read-only. No debe impedir el arranque del MCP.

---

## 5. Contrato mínimo

### 5.1 Read model (state dir)

El panel normaliza defensivamente; todos los campos pueden faltar. Reglas:

- Solo directorios `jobs/<id>` con `id` que cumpla `/^[A-Za-z0-9_-]+$/`.
- `job.json`: si el parseo falla, conservar la última copia válida y mostrar warning; nunca romper el panel.
- `status` desconocido → `unknown` (mostrar tal cual, sanitizado).
- Fechas ISO 8601; `elapsed` desde `startedAt` o `createdAt` hasta `finishedAt` o ahora.
- `events.ndjson`: ignorar líneas malformadas y la última línea parcial; tope 3,5 MB (como el pane) o leer solo la cola.
- `final.md`: solo para terminales; tope 1 MB; primeras N líneas en el panel.
- No leer `stderr.log`: no se escribe. Usar `job.json.stderrTail` (máx. 64 KB).

Campos que debe mostrar el panel:

| Grupo | Campos |
|---|---|
| Identidad | `id`, `label`, `groupId`, `groupName`, `ownerId` |
| Estado | `status`, `reason`, `createdAt`, `startedAt`, `finishedAt`, `turnEndKind`, `errorMessage` |
| Backend | `profile`, `provider`, `model` |
| Ejecución | `cwd`, `access`, `isolation`, `worktree{path,branch,baseCommit,repoRoot,cleaned}`, `pid`, `sessionId` |
| Progreso | `steps`, `toolCalls`, `lastTool`, `eventsCount`, `malformedLines`, `last_event_at` (mtime) |
| Uso/coste | `usage{inputTokens,outputTokens,totalTokens,cacheReadTokens,cacheWriteTokens,reasoningTokens}`, `costUsd` (estimado; `null` si no hay pricing) |
| Alertas | `alerts[{kind,message,since}]` |
| Linaje | `resumeOf`, `steeredFrom` |
| Resultado | `final.md` (preview), `stderrTail`, diff bajo demanda |

`cleaned` debe leerse de dos sitios: `job.cleaned` (top-level) y `job.worktree.cleaned`; el writer usa el primero y varios readers históricos usan el segundo.

**Nota de coste:** `costUsd` en `job.json` se calcula al escribir; `dsh_status` lo recalcula en vivo. El panel puede mostrar el persistido y, si consulta `/v1/jobs`, el vivo. Si el modelo no está en `src/pricing.ts`, mostrar `n/d`, no `$0`.

### 5.2 Control API

Base: `http://127.0.0.1:<port>/v1`. Todas las rutas requieren `Authorization: Bearer <token>`. Respuestas JSON; errores con `error` estable y `message` legible.

| Método | Ruta | Body | Respuesta | Errores |
|---|---|---|---|---|
| GET | `/v1/health` | — | `{ok, protocol, version, owner_id, pid, ready, state_dir, max_concurrent, max_queue, running, queued}` | 401, 503 (starting) |
| GET | `/v1/jobs` | — | `{server:{...}, jobs:[JobView]}` | 401 |
| GET | `/v1/jobs/:id` | — | `{job: JobView}` | 401, 404 |
| GET | `/v1/jobs/:id/events?cursor=&limit=` | — | `{job_id, status, reason, session_id, events, next_cursor, total_events, has_more}` | 401, 404, 400 |
| GET | `/v1/jobs/:id/result?max_chars=&include=final,diff_stat,diff,stderr_tail,events_tail` | — | `{job_id,status,reason,session_id,profile,provider,model,usage,cost_usd,final,final_truncated,changes?,stderr_tail?,events_tail?,notice}` | 401, 404, 400, 500 |
| POST | `/v1/jobs/:id/cancel` | `{}` | `{job_id,status,killed_pids,survivors}` | 401, 404, 409 `already_settled`, 503 |
| POST | `/v1/jobs/:id/steer` | `{message, timeout_s?}` | `{job_id,steered_job_id,cancelled,status,label,group_id,group_name,queue_position?,cwd,steered_from}` | 401, 404, 409 `resume_unavailable`/`steer_timeout`/`write_conflict`, 400, 503 |
| POST | `/v1/jobs/:id/cleanup` | `{discard_changes?}` | `{job_id, worktree, branch_deleted}`; `worktree` es uno de `removed`, `none`, `preserved_dirty` | 401, 404, 409 `not_terminal`/`worktree_busy`, 500 |
| DELETE | `/v1/jobs/:id?discard_changes=1` | — | `{job_id,deleted:true,worktree,branch_deleted}` | 401, 404, 409 `job_active`/`worktree_dirty`/`worktree_busy`, 500 |
| GET | `/v1/stream?job_id=&cursor=` (opcional) | — | SSE: `jobs`, `events`, `reset`, `stream_error` | 401 |

**JobView** (snake_case en la API; camelCase en disco; `usage` conserva los nombres camelCase de DSH). `GET /v1/jobs` devuelve los jobs que conoce ese manager (propios + terminales adoptados del disco); `owned=false` para los ajenos. El panel usa el state dir para la lista y este endpoint solo para metadatos/capacidades del owner:

```json
{
  "job_id": "j_ab12cd34ef56",
  "label": "fix-auth",
  "status": "running",
  "reason": null,
  "owner_id": "uuid",
  "owned": true,
  "group_id": "uuid",
  "group_name": "my-project",
  "profile": "personal-deepseek",
  "provider": "deepseek-official",
  "model": "deepseek-flash",
  "access": "workspace-write",
  "isolation": "worktree",
  "cwd": "/home/me/.local/state/dsh-workers/worktrees/j_...",
  "worktree": {"path":"...","branch":"dsh/j_...","base_commit":"...","repo_root":"...","cleaned":false},
  "created_at": "...",
  "started_at": "...",
  "finished_at": null,
  "elapsed_s": 42,
  "queue_position": null,
  "session_id": "session-...",
  "pid": 12345,
  "steps": 7,
  "tool_calls": 12,
  "last_tool": "bash",
  "last_event_s_ago": 2,
  "malformed_lines": 0,
  "events_count": 88,
  "usage": {"inputTokens":1,"outputTokens":2,"totalTokens":3},
  "cost_usd": 0.0123,
  "alerts": [{"kind":"stalled","message":"no events for 2m","since":"..."}],
  "resume_of": null,
  "steered_from": null,
  "capabilities": {
    "cancel": true,
    "steer": true,
    "cleanup": false,
    "delete": false,
    "read_result": true,
    "read_events": true,
    "cleanup_discard": false,
    "delete_discard": false
  }
}
```

**Capacidades** (calculadas en servidor y replicadas en el panel para deshabilitar):

- `cancel = status ∈ {queued, starting, running}`.
- `steer = session_id != null && (activo || (terminal && !worktree.cleaned))`. **No habilitar steer activo sin session_id**: el manager cancela primero y luego falla `resume_unavailable` (`src/jobs.ts:967-990`), dejando el original cancelado.
- `cleanup = terminal && worktree != null && !worktree.cleaned && !worktreeBusy`.
- `delete = terminal && !worktreeBusy`; el dirty se descubre al llamar y se responde 409.
- `worktreeBusy = existe otro job activo con el mismo worktree.path o la misma sesión que el job objetivo`.
- `cleanup_discard/delete_discard` se habilitan solo después de un 409/`preserved_dirty` y una confirmación explícita.

**Semántica de steer:** es cancelar + reanudar, no enviar un mensaje al proceso vivo. Si el resume falla después de cancelar (session lock, perfil, worktree limpiado), el job original queda `cancelled`; la UI debe confirmarlo explícitamente y mostrar el error con esa consecuencia.

**Errores** (mapeo de `JobError`):

| HTTP | `error` | Cuándo |
|---|---|---|
| 400 | `invalid_request`, `invalid_job_id`, `invalid_cursor`, `invalid_include`, `cwd_outside_roots`, `unknown_profile` | validación |
| 401 | `unauthorized` | token ausente/incorrecto |
| 404 | `unknown_job`, `job_not_found` | no existe |
| 409 | `already_settled`, `not_terminal`, `job_active`, `worktree_dirty`, `worktree_busy`, `not_owner`, `resume_unavailable`, `steer_timeout`, `write_conflict`, `queue_full`, `depth_exceeded` | estado incompatible |
| 503 | `dsh_unavailable`, `shutting_down`, `not_ready` | servidor no disponible |
| 500 | `internal_error`, `spawn_error`, `worktree_error`, `driver_error` | fallo inesperado |

Cuerpo de error:

```json
{"error":"worktree_dirty","message":"worktree has uncommitted changes...","job_id":"j_...","status":"succeeded","worktree":"preserved_dirty"}
```

**Descriptor** en `<stateDir>/control/<ownerId>.json` (0600, directorio 0700, escritura atómica):

```json
{
  "protocol": "dsh-workers-control/1",
  "owner_id": "96d64d5e-...",
  "pid": 36189,
  "pid_start": "2819874",
  "port": 47231,
  "base_url": "http://127.0.0.1:47231",
  "token": "base64url-32-bytes",
  "started_at": "2026-10-21T09:00:00.000Z",
  "version": "0.4.0",
  "state_dir": "/home/me/.local/state/dsh-workers",
  "ready": true
}
```

El panel valida: nombre `^[A-Za-z0-9_-]+\.json$`, fichero regular, modo sin bits de grupo/otros (POSIX), `owner_id` coincide con el nombre, `pid` vivo (y `pid_start` si está; en no-Linux suele faltar), `ready:true`, `protocol` conocido. Descarta descriptors obsoletos; si hay varios para el mismo owner, elige el de `started_at` más reciente y haz health check.

### 5.3 Refresco y concurrencia

- **State dir:** cada 1000 ms si hay jobs activos o el panel está visible; 3000-5000 ms en idle. Cache por `mtimeMs + size` de `job.json`, `events.ndjson` y `final.md`. No leer eventos de jobs terminales salvo el seleccionado/expandido.
- **Events:** para activos y seleccionado, leer cola o fichero completo con tope 3,5 MB; parsear defensivamente; conservar cursor/índice. Si el fichero crece, leer desde el offset anterior o reusar el enfoque del pane.
- **Final:** solo para el job terminal seleccionado/expandido; una lectura por mtime.
- **Descriptors/health:** cada 5000 ms; timeout 800 ms por owner; backoff 1/2/5/10 s si falla.
- **Acciones:** una en vuelo por job; deshabilitar botones mientras `pending`; al responder 2xx refrescar de inmediato; 409/404 refrescar y mostrar mensaje; `steer` puede tardar hasta ~30 s + arranque, mostrar progreso.
- **Sin `dsh_wait`:** el panel no debe long-poll; ya tiene polling/SSE.
- **SSE opcional:** si se añade, reutilizar el patrón de `src/ui.ts:159-221` (snapshot + página + reset cuando `total_events < cursor`). No es necesario para v1.
- **Límites:** max 3 running/16 queue por defecto; `queue_position` solo se conoce por `/v1/jobs` del owner. Si no hay control, mostrar “queued” sin posición.

### 5.4 Seguridad

- Bind exclusivo a `127.0.0.1`; puerto efímero; sin IPv6/0.0.0.0.
- Token aleatorio (32 bytes base64url) en descriptor 0600; comparación `timingSafeEqual`; nunca loguear el token.
- Validar `Host` (`127.0.0.1:<port>`/`localhost:<port>`) y `Origin` (ausente o mismo origen) para evitar DNS rebinding/CSRF; exigir `Content-Type: application/json` en POST/DELETE; sin CORS; sin cookies.
- Límite de body 64 KB; `message` ≤20.000; `timeout_s` 60..3600; `max_chars` 1000..50.000; `cursor`/`limit` acotados.
- `job_id` regex; nunca construir rutas con input sin validar.
- Owner check en **todas** las acciones: `job.owner_id === descriptor.owner_id`; si no, 409 `not_owner`. Esto evita que un manager borre/limpie el job de otro.
- `worktree_busy`: rechazar cleanup/delete si otro job activo comparte worktree/sesión.
- Sanitizar todo texto no confiable (labels, events, final, stderr, alerts): eliminar ANSI/C0/C1, colapsar espacios, truncar a la anchura. El render de terminal es un sink de escapes.
- Confirmaciones: dos pulsaciones en 5 s para cancel/cleanup/delete; segunda confirmación para discard; nunca en el primer press; nunca para jobs activos en delete/cleanup.
- No exponer `task`, entorno, API keys ni el token en respuestas/logs. `final/events/stderr` son datos del worker, no instrucciones.
- El plugin dsh-tui es código en proceso sin sandbox: instalar solo código auditado/pinneado. Los permisos del manifiesto no limitan fs/red.
- Opción de hardening: UDS 0600 + `SO_PEERCRED` en Linux; HTTP loopback con token es suficiente para el mismo usuario.

### 5.5 UX del panel

Con 28-64 columnas típicas:

- **Header:** `Workers` + `2 run · 1 queued · 3 done` + coste/tokens visibles + estado del control (`control: 2 owners` / `read-only`).
- **Lista:** una fila por job; glifo de estado + label; segunda línea `model · 12 steps · $0.09 · 2m`; línea de alerta si hay; `queued #n` cuando se conozca. Agrupar por `group_id` (nombre visible), colapsable.
- **Detalle:** estado/reason, profile/provider/model, access/isolation, cwd/worktree, session, tiempos, usage/coste, alerts, actividad reciente (últimos 8 tool calls), último text/error, preview de final; `result`/diff bajo demanda.
- **Teclas (solo con foco):** `↑/↓` mover, `Enter` expandir, `c` cancel, `s` steer, `x` cleanup, `d` delete, `r` refrescar, `a` alternar all/project, `o` abrir dashboard, `?` ayuda. Las acciones destructivas muestran `confirm …?` en el footer y requieren segunda pulsación.
- **Steer:** el diálogo `tuiDialogs.input` está limitado a 500 celdas; para un mensaje self-contained largo, abrir una escena full-screen con editor multilínea (fase 3) o un comando `/workers steer <id> --file <path>`. En v1, si se usa diálogo, avisar del límite y no truncar silenciosamente.
- **Final:** el panel no tiene Markdown; mostrar texto plano con `ScrollBox` y ofrecer `o` (dashboard en navegador) o una escena de lectura. No intentar renderizar HTML.
- **Badge:** `host.notify('warning', n)` con fallos/alertas no vistas; limpiar al enfocar. No abrir el panel automáticamente (rate limit 5 s y puede interrumpir).
- **Read-only:** si no hay descriptor vivo, banner `control offline — solo lectura` y acciones deshabilitadas; el listado sigue funcionando.
- **Persistencia:** `host.storage` para `selectedId`, `expandedIds`, filtro, `showAll`; no guardar datos sensibles.

---

## 6. Acoplamientos y riesgos

| # | Riesgo | Severidad | Evidencia | Mitigación |
|---|---|---|---|---|
| 1 | Un segundo MCP server interrumpe/mata jobs vivos de otro owner | **Alta** | `src/jobs.ts:392-427` | Lease/descriptor por owner; `loadPreviousJobs` salta jobs de owners vivos; el panel nunca instancia manager |
| 2 | Un job terminal comparte worktree con un job steerado activo; cleanup/delete del original lo borra | **Alta** | `src/jobs.ts:550-573, 1179-1214` | `worktree_busy` en servidor y panel; no cleanup/delete si hay job activo con mismo path/sesión |
| 3 | `state_dir` distinto entre el plugin de Claude Code y el plugin de dsh-tui (userConfig vs env) | **Alta** | `hooks/jobs.ts:979-989`; `README.md:302-309` | Config explícita `stateDir`; mostrar ruta resuelta; documentar; opcional leer config de Claude Code (frágil) |
| 4 | `steer` activo sin `sessionId` cancela el original y luego falla | **Alta** | `src/jobs.ts:967-990` | `capabilities.steer` exige `session_id`; deshabilitar hasta que exista |
| 5 | Borrar/limpiar un job de otro owner desde el manager equivocado | **Alta** | `src/jobs.ts:1197-1214`; `src/admin.ts:80-122` | Owner check en control; routing por `owner_id`; no actuar si el owner no está vivo |
| 6 | Inyección de escapes ANSI desde labels/eventos/final/stderr | **Media-alta** | `hooks/jobs.ts:275-280` (sanitize) | Sanitizar todo; truncar; no renderizar raw |
| 7 | API de paneles experimental; cambios en 0.17 | **Media** | `panels.d.ts:26`; `plugins.md:35,44-51` | Feature-detect `ctx.get('tuiPanels', false)`; pin 0.16.x; fallback a status-line/escena |
| 8 | El panel no tiene Markdown/TextInput; steer limitado a 500 celdas | **Media** | `panels.d.ts:45-64`; `dialogs.d.ts:80` | Texto plano + escena para final/steer; comando con fichero |
| 9 | Sin webview: no se puede reutilizar el dashboard HTML | **Media** | dsh-tui TUI/Ink; `README.md:38` | Panel nativo + abrir dashboard en navegador |
| 10 | Plugin dsh-tui sin sandbox; supply chain | **Media** | `dsh-tui-quotas` lee credenciales/red | Pin/auditar; permisos de manifiesto no limitan fs/red; código mínimo |
| 11 | Polling 1 s con muchos jobs/eventos grandes | **Media** | `hooks/register.tsx:489-595`; `EVENTS_MAX_BYTES` | Cache por mtime/size; tail; topes; intervalo adaptativo; no leer terminales no seleccionados |
| 12 | Carrera entre agente y panel (ambos cancel/steer/delete) | **Media** | `src/jobs.ts:961-964` (steering guard) | 409 → refrescar; una acción en vuelo; idempotencia; no reintentar a ciegas |
| 13 | Coste desconocido o desactualizado | **Baja-media** | `src/pricing.ts:20-69` | Mostrar `n/d`; explicar “estimado”; no inventar $0 |
| 14 | `stderr.log` no existe aunque el README lo mencione | **Baja** | `src/jobs.ts:652`; no writer | Usar `stderrTail`; corregir README |
| 15 | Owner muerto deja `job.json` en running; no se puede limpiar desde el panel | **Media** | `src/jobs.ts:392-427` | Mostrar “owner offline”; recuperación al arrancar un MCP nuevo; fase 3 acción admin con lease |
| 16 | Descriptor/token obsoleto o carrera de escritura | **Baja-media** | diseño | Escritura atómica; validar modo/pid/protocol; reintentar 401 una vez; prune |
| 17 | stdout contaminado por logs del control server | **Alta impacto, baja prob.** | `src/server.ts:397` (stdio MCP) | Todos los logs a stderr; test de stdout limpio |
| 18 | El panel desaparece si el usuario lo quita de `sidePanel.panels` | **Baja** | `settings/definitions.js:270-278` | `/workers` detecta y ofrece habilitarlo/toast |
| 19 | `cleaned` se escribe top-level pero algunos readers miran `worktree.cleaned`; cleanup/delete se ofrecen de más | **Media** | `src/jobs.ts:207`; `hooks/jobs.ts:109-123`; `src/dashboard.ts:170-180` | Normalizar `cleaned` desde ambos sitios; tests con job limpiado |

---

## 7. Plan de implementación por fases

### Fase 0 — Contrato y spike (1-2 días)

**Objetivo:** validar la API de panel y cerrar el contrato antes de tocar jobs.

- Escribir `docs/control-protocol.md` con §5.2/§5.3 y ejemplos.
- Crear un fixture de state dir (jobs falsos con todos los estados) y un panel esqueleto que renderice lista/detalle con datos falsos.
- Validar en dsh-tui 0.16.1: registro, prefijo de id, `Ctrl+B`, `sidePanel.panels`, foco/teclas, badge, resize a 28/40/60/100 columnas, comportamiento en `zoom/fullscreen`.
- Decidir HTTP loopback vs UDS y el formato de config del plugin.

**Salida:** contrato congelado + spike visual; sin cambios en dsh-workers.

### Fase 1 — Control plane y leases en dsh-workers (3-5 días)

**Objetivo:** acciones seguras y multi-owner.

- `src/control/protocol.ts`, `descriptor.ts`, `server.ts`, `service.ts`, `client.ts`.
- `src/owner-lease.ts` y modificación de `JobManager.init()/loadPreviousJobs()` para saltar jobs de owners vivos.
- `worktree_busy` en `cleanup/delete` (y `types.ts`/`server.ts` mapping).
- Wire en `src/server.ts`: arranque antes de `init`, `ready`, shutdown, logs a stderr.
- Endpoints v1: health, jobs, events, result, cancel, steer, cleanup, delete; SSE opcional.
- Tests:
  - unit: auth, descriptor, body limits, error mapping, capabilities;
  - integración con el `fakeDsh` de `test/jobs.spec.ts` (sin jobs reales): start → cancel/steer/cleanup/delete; 409/404/401;
  - multi-owner: A con job vivo, B arranca y **no** lo interrumpe; routing por owner;
  - stdout limpio y descriptor eliminado al shutdown.
- `pnpm bundle`; actualizar `plugin-dist/server.mjs`; `bundle:check`.

**Salida:** control API usable por curl/tests; MCP tools sin cambios; panel aún no.

### Fase 2 — Plugin dsh-tui y panel MVP (5-8 días)

**Objetivo:** panel usable para observar y cancelar/limpiar/borrar.

- Paquete nuevo `dsh-tui-workers` (recomendado en `/home/cesardiaz/projects/dsh-tui-plugins/dsh-tui-workers`, o `tui/` en el repo si se quiere versionar junto):
  - `package.json` con `dsh.bundle.patch`, `dsh-plugin.json` (manifest 0.15, `facets.host.entry`, contrato Command, permisos vacíos), `cordis.patch.yml`.
  - `src/config.ts` (stateDir, refresh, showAll, maxTerminal, control timeout, keybind).
  - `src/state-reader.ts` (normalización, mtime cache, events/final caps, sanitize).
  - `src/control-client.ts` (discovery, health, acciones, 401 retry).
  - `src/store.ts` (snapshot + subscribe; polling en `apply`, no en render).
  - `src/panel.ts` (lista/detalle/acciones; `props.React.createElement`; `ui.Box/Text/ScrollBox`).
  - `src/actions.ts` (doble confirmación, dirty/discard, pending).
  - `src/format.ts` (estado, duración, coste, tokens, alertas).
  - comando `/workers` y shortcut opcional; badge.
- Instalación en el perfil: `/plugin install /path/to/dsh-tui-workers` o `link:` + `dsh.profile.bundles`; reiniciar dsh-tui.
- Tests: normalización, sorting/filtrado, formateo, control client con HTTP falso, acciones/capacidades; smoke manual en TUI.
- Documentar: config, state dir, read-only fallback, limitaciones.

**Salida:** panel MVP con lista, detalle, cancel/cleanup/delete; steer queda para fase 3 (o diálogo corto con aviso).

### Fase 3 — Steer, lectura rica y hardening (3-5 días)

- Escena de steer con editor multilínea (o comando `--file`), validación 20k, resultado con `steered_job_id`.
- Vista de final completa en escena/ScrollBox, diff stat y archivos; abrir dashboard en navegador.
- SSE o polling adaptativo; merge multi-owner; stale owners; reintentos.
- `worktree_busy` y owner checks en UI (capabilities); acciones admin para huérfanos con lease (opcional).
- Auditoría local `state/audit.ndjson` (acción, job, resultado; sin mensajes), rate limit.
- Tests de seguridad: 401/403/409, Host/Origin, body grande, ANSI injection, symlink descriptor, token no logueado.
- Revisión de la API experimental de dsh-tui; fallback si falta `tuiPanels`.

### Fase 4 — Release y operación (1-2 días)

- Versionar: dsh-workers 0.4.0 (nueva feature), plugin 0.1.0, protocolo v1.
- `pnpm test`, `pnpm lint`, `pnpm bundle`, `bundle:check`, `claude plugin validate`; build del plugin TUI.
- README: sección “TUI side panel”, instalación, configuración, seguridad, diferencias con dashboard/pane.
- Matriz de compatibilidad: dsh-tui ≥0.16.1 <0.17; dsh-workers ≥0.4.0.
- Plan de rollback: `/plugin disable dsh-tui-workers`; el MCP sigue funcionando; el control server se puede desactivar con `DSH_WORKERS_CONTROL=0`.

**Estimación total:** 2-3 semanas de una persona, dependiendo del editor de steer y del fix multi-owner. El MVP (fases 0-2) se puede tener en ~1,5 semanas.

---

## 8. Decisiones abiertas

1. **HTTP loopback vs UDS.** HTTP es simple, cross-platform y reutilizable por el dashboard/CLI; UDS es más fuerte en multiusuario. Recomendado HTTP + token para v1, UDS como opción.
2. **¿Permitir `start` desde el panel?** No en v1. Lanzar workers es trabajo del agente/skill; añadirlo exige task input, perfiles, roots y política. Si se añade, `POST /v1/jobs` con validación estricta y confirmación.
3. **Steer: diálogo de 500 celdas vs escena.** El diálogo es rápido pero corto; la escena es más trabajo pero correcta para mensajes self-contained. Recomendado escena en fase 3; en MVP, deshabilitar steer o usar diálogo con aviso.
4. **Modelo de vista compartido.** ¿Extraer las funciones puras de `hooks/jobs.ts` a un paquete compartido o duplicarlas en el plugin TUI? Recomendado empezar duplicando lo mínimo con tests de contrato; extraer si aparece drift.
5. **SSE.** No es necesario para el panel; útil para un futuro dashboard/web o para muchos jobs. Dejar el endpoint diseñado pero implementarlo en fase 3.
6. **Multi-owner.** ¿Se corrige `loadPreviousJobs` en la misma entrega (recomendado) o se restringe el panel a un solo owner hasta después? Sin el fix, las acciones no son seguras con varias sesiones.
7. **Dashboard.** ¿Se actualiza para usar el control API (cancel/steer) o se deja read-only? Fuera de alcance; el panel es la superficie de control.
8. **Localización.** El panel puede empezar en inglés; dsh-tui soporta zh/en. Usar `host.snapshot().lang` si se quiere i18n.

---

## 9. Referencias principales

### dsh-workers

- `src/server.ts:43-60` instrucciones; `63-363` tools; `397` stdio.
- `src/jobs.ts:169-213` persisted; `266-293` estado del manager; `392-427` loadPreviousJobs; `489-679` start; `681-705` dispatch; `746-804` launch; `806-893` onClose; `909-944` cancel; `954-1017` steer; `1113-1123` events; `1125-1177` result; `1179-1195` cleanup; `1197-1214` delete; `1271-1316` summary; `1361-1370` atomic write.
- `src/admin.ts:80-122` delete; `131-176` prune.
- `src/proc.ts:67-82` readStartTime; `148-171` killTreeByPid.
- `src/types.ts:3-11` estados; `74-103` JobSummary.
- `src/config.ts:114-118` state dir; `182-200` límites.
- `hooks/register.tsx:71` refresh; `489-595` refresh; `646-648` timer; `1256-1380` acciones; `287-338` confirmaciones.
- `hooks/jobs.ts:46-50` topes; `178-245` normalización; `283-345` estado; `397-465` eventos; `507-513` filtro; `723-757` meta; `979-989` state dir.
- `src/ui.ts:13-15` host/puerto; `159-221` SSE; `230-254` DELETE; `281-317` API.
- `src/dashboard.ts:112-116` read-only; `116-215` jobs.
- `src/dashboard.html:838-923` SSE/delete.
- `README.md:26-27` no son subagentes nativos; `52-53` steer; `178-182` dashboard read-only; `228-231` no es el panel TUI; `302-320` state dir; `540-552` tools; `589-596` seguridad; `619-632` limitaciones.

### dsh-tui 0.16.1

- `package.json:3` versión.
- `lib/types/dsh-adapter/panels.d.ts:26,28,32,33,45-64,117-160,162-180,229,237,241`.
- `lib/types/dsh-adapter/panels.js:214-215,240-248,259-262,295-320`.
- `lib/types/dsh-adapter/dialogs.d.ts:80` INPUT_CELLS; `dialogs.js:37`.
- `lib/types/dsh-adapter/scenes.d.ts:20-30` escenas.
- `lib/types/ui.d.ts:7-30` exports del kit (sin Markdown/TextInput).
- `cordis.patch.yml:291-296` fila `dsh-tui-panels`; `411` inject de `tuiPanels`.
- `guide/dsh-tui-guide/plugins.md:35,44-51,57-58,65` paneles experimentales/instalación.
- `guide/dsh-tui-guide/configuration.md:316-344` MCP stdio/streamable HTTP.
- `README.md:38` side panel; `473-480` `/plugin install`.
- `lib/types/settings/definitions.js:270-278` `sidePanel.panels`.
- `~/.dsh/profiles/dsh-tui/package.json:4-17` bundles; `cordis.patch.yml:4-40` providers.
- `/home/cesardiaz/projects/dsh-tui-plugins/dsh-tui-quotas/src/index.ts:237-341` patrón de plugin (inject/scene/status/command/timer); `src/view.ts:9-45` patrón de render con React del host.
- `src/jobs.ts:207` `cleaned` top-level; `hooks/jobs.ts:109-123` y `src/dashboard.ts:170-180` lectores de `worktree.cleaned`.

---

## 10. Conclusión

El panel debe ser **nativo y delgado**: el state dir ya contiene casi todo lo que necesita la UI (estado, modelo/backend, coste, eventos, final), y el único hueco real son las acciones que requieren el `JobManager`. Ese hueco se cubre con un control HTTP loopback embebido en el MCP, con descriptor por owner y token, no con un segundo servidor MCP ni con un webview inexistente. La condición para que sea seguro en el uso real (varias sesiones/owners, steer con worktree compartido) es arreglar antes el arranque multi-owner y añadir la guarda `worktree_busy`; sin eso, el panel sería una forma cómoda de romper workers vivos.
