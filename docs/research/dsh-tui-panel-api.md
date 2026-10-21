# dsh-tui 0.16.1 — ¿Se puede añadir un side panel personalizado?

**Investigación:** 2026-10-21 · Linux · sin modificar el repo ni instalar paquetes.
**Paquete inspeccionado:**
/home/cesardiaz/.volta/tools/image/packages/@deepseek-harness-tui/dsh-tui/lib/node_modules/@deepseek-harness-tui/dsh-tui
**Perfil vivo:** ~/.dsh/profiles/dsh-tui (0.16.1, launcher y perfil alineados; dsh-tui doctor ✓).
**Binario:** dsh-tui / dst.

---

## TL;DR — veredicto

**Sí, dsh-tui 0.16.1 permite añadir un panel lateral propio, y hay una API pública para ello.**
No es una API estable: es la costura **experimental** ctx.tuiPanels (seam §18, TUI_PANEL_API_VERSION = 1),
pensada exactamente para plugins de terceros. Un plugin registra un descriptor con un componente React
y el host lo pinta en la barra lateral derecha, con badge, foco y teclado.

- **No hay forma “solo configuración”** de definir un panel: sidePanel.panels únicamente habilita/ordena
  IDs de paneles **ya registrados**. La definición siempre es código de plugin.
- **No hace falta forkear dsh-tui** para un panel de solo lectura.
- **Sí hace falta** un paquete/bundle de plugin instalado en el perfil (dsh.profile.bundles) — es el
  mecanismo oficial de extensión (opción A+B combinadas, no alternativas).
- Para “Agent Workers” el panel puede mostrar los jobs/subagentes **de la sesión TUI** vía
  host.snapshot(), pero los workers de dsh-workers son **procesos headless separados**: hay que
  leer su estado en disco (~/.local/state/dsh-workers/jobs/*/job.json) o construir un productor de estado.
  pi no expone un registro de jobs equivalente en este equipo.
- **Riesgo principal:** costura experimental, sin control de jobs (kill/steer/attach) y con
  sendToChat deshabilitado. Para acciones integradas habría que ir a un canal propio o fork.

**Esfuerzo estimado:** 4–8 h para un panel read-only funcional; 1–2 días con badge, foco, tests,
i18n y pulido. Instalación: ~15 min con el patrón link: ya usado por dsh-tui-quotas/dsh-tui-stt.

---

## 1. Arquitectura: Cordis + Ink/React, no un “plugin de config”

dsh-tui es una aplicación **Cordis** (árbol de servicios/plugins) con render **Ink/React** en terminal.
Cada fila del perfil es un plugin Cordis; el perfil se compone por capas:

1. ~/.dsh/profiles/dsh-tui/cordis.yml es una lista vacía; el árbol se compone por parches.
2. package.json del perfil declara dsh.profile.bundles (orden de capas).
3. Cada bundle aporta un cordis.patch.yml que inserta filas (- insert: [{ id, name }]).
4. El cordis.patch.yml del usuario se aplica al final.

Evidencia del perfil vivo:

~~~json
// ~/.dsh/profiles/dsh-tui/package.json:9-17
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-harness-tui/dsh-tui",
  "dsh-tui-stt",
  "dsh-tui-quotas"
] } }
~~~

~~~yaml
# ~/.dsh/profiles/dsh-tui/cordis.patch.yml (capa de usuario; aquí no hay paneles)
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config: { ... }
~~~

El propio paquete declara las costuras de UI como filas opcionales; la de paneles está en
cordis.patch.yml:291-295:

~~~yaml
# Optional plugins register side-panel surfaces (sidebar Panel +
# compact row, experimental §18) here; admission, budgets and crash
# isolation remain owned by the tuiPanels runtime + PanelStore.
- id: dsh-tui-panels
  name: '@deepseek-harness-tui/dsh-tui/panels'
~~~

Y la app principal la inyecta explícitamente (cordis.patch.yml:407-411):

~~~yaml
- id: dsh-tui
  name: '@deepseek-harness-tui/dsh-tui'
  inject: [workspaceRegistry, agents, tuiWorkspaces, tuiScenes, tuiPanels,
           tuiDialogs, tuiStatus, tuiShortcuts, tuiRenderers, tuiThemes]
~~~

> Nota de despliegue: el host tiene un guard de desalineación. Si el perfil es más viejo que el
> paquete, avisa “tuiPanels service is not mounted; plugin side panels will never register”
> (lib/types/dsh-adapter/plugin.js:439-446). En este equipo dsh-tui doctor confirma perfil 0.16.1
> alineado, así que la fila está presente.

### ¿Qué es una “contribution” aquí?

No hay un fichero declarativo de “panel” en dsh-plugin.json. Las contribuciones de UI son
**imperativas**: el plugin recibe el contexto Cordis (apply(ctx)) y llama a un servicio
(ctx.tuiPanels.register(...), ctx.tuiScenes.register(...), ctx.tuiStatus.registerView(...)).
El dsh-plugin.json sirve para la **admisión del paquete** (identidad, facet host, permisos,
contratos); no declara paneles. Los contratos publicados en tui-profile/registry/contracts/
(backend, scene, settings-section, decision-events, tui-channel, workspace-provider) **no incluyen
un contrato Panel**.

### Superficie pública

package.json:76-99 exporta:

| Subpath | Para qué |
| --- | --- |
| @deepseek-harness-tui/dsh-tui/panels | TuiPanelRuntime, tipos TuiPanelDescriptor/Props/HostApi/Snapshot, TUI_PANEL_API_VERSION |
| .../api | entrada **solo tipos** (incluye paneles, escenas, settings, etc.) |
| .../extensions | dialogs, status, shortcuts, renderers, toast, themes |
| .../scenes | escenas a pantalla completa |
| .../jsx-runtime | runtime JSX (React) |
| .../plugin-host | storage, grants, message observer, ledger |

La API de paneles está marcada como **experimental** en la guía:
guide/dsh-tui-guide/plugins.en.md:40 la lista en la fila “Experimental (may still shift…)”
junto a decision events y toast. La descripción funcional está en plugins.en.md:50-59.

---

## 2. La API de paneles en detalle

### 2.1 Tipos y contrato

Fichero clave: lib/types/dsh-adapter/panels.d.ts (re-exportado por lib/types/panels.d.ts).

~~~ts
// panels.d.ts:26
export declare const TUI_PANEL_API_VERSION = 1;
// panels.d.ts:28,30,32
export declare const MAX_PANELS_PER_PLUGIN = 4;
export declare const MAX_PLUGIN_PANELS_TOTAL = 32;
export declare const PANEL_OPEN_RATE_LIMIT_MS = 5000;

// panels.d.ts:140-150
export interface TuiPanelProps {
  readonly React: typeof React;
  readonly ui: TuiPanelUi;
  readonly host: TuiPanelHostApi;
  readonly width: number;
  readonly height: number;
  readonly focused: boolean;
  readonly visible: boolean;
  readonly mode: 'split' | 'zoom' | 'fullscreen';
}

// panels.d.ts:162-176
export interface TuiPanelDescriptor {
  readonly apiVersion: typeof TUI_PANEL_API_VERSION;
  readonly id: string;                 // slug de una sola pieza; el host antepone '<pluginId>:'
  readonly title: string;
  readonly icon?: string;              // ancho de display exactamente 1
  readonly minColumns?: number;        // 12..64, por defecto 28
  readonly order?: number;
  readonly component?: React.ComponentType<TuiPanelProps>;
  readonly compact?: { maxRows: 1 | 2 | 3; component: ... };
}

// panels.d.ts:229
register(descriptor: TuiPanelDescriptor, identity?: Context): (() => void) | undefined;
~~~

~~~ts
// panels.d.ts:118-138 — host API dentro del panel
export interface TuiPanelHostApi {
  snapshot(): TuiPanelSnapshot;       // copia estructural, solo campos curados
  readonly focused: boolean;
  notify(level: 'info' | 'warning' | 'error', unread?: number): void;
  clearBadge(): void;
  sendToChat(payload: { title: string; content: string }): boolean; // SIEMPRE false en 0.16.1
  openScene(id: string): boolean;     // solo escenas propias
  toast(text: string): boolean;
  readonly storage: TuiPluginStorage | undefined;
  onKey(listener: (event: TuiPanelKeyEvent) => void): () => void; // solo con foco
  focus(): boolean;
}
~~~

El snapshot curado (panels.d.ts:76-116) incluye justo lo que interesa para “Agent Workers”:

~~~ts
sessionId, cwd, lang, working, spinnerMode, version,
goal?,
todos[],
backgroundJobs[]: { id, kind, label, status, progress?, detail?, startedAt },
subagents[]:      { agentId, description, status, mode?, model?, startedAt, completedAt? },
attention:        { approvals, questions },
activity?
~~~

**No incluye** el texto de la conversación, credenciales, contenido de ficheros, command, las
líneas de salida del job ni un jobControl. Es deliberadamente de solo lectura.

### 2.2 Qué hace register() exactamente

Implementación: lib/types/dsh-adapter/panels.js:131-274.

1. Comprueba la política de sombreado de capacidades (host.panels.register).
2. Exige una activación de plugin **no-root viva** (requirePluginCaller); si no, warn y undefined.
3. Valida apiVersion === 1, id (/^[a-z][a-z0-9_-]*$/), title no vacío, icon de ancho 1,
   component función, compact (1–3 filas), minColumns (12–64), order finito.
4. Construye el id final: finalId = pluginId + ':' + descriptor.id (panels.js:214-215).
5. Límites: ≤4 paneles por plugin, ≤32 globales (panels.js:221-230).
6. Fuerza mountPolicy: 'active' (panels.js:240-241): el panel **solo se monta cuando está activo**;
   no conserva estado al cambiar de pestaña (a diferencia de los built-ins, que usan enabled).
7. Envuelve el componente con makePluginPanelComponent (error boundary, snapshot, teclado).
8. **Auto-habilita** el panel en la lista sidePanel.panels (panels.js:249-250): aparece en la
   PanelBar sin editar config.
9. Devuelve un dispose() ligado al efecto de la activación: al descargar el plugin se desregistra.

### 2.3 Render, actualización y foco

- El componente recibe React del host y un kit ui (Box, Text, Image, ScrollBox,
  Divider, useTerminalSize, useAnimationTime, useTheme). **Regla single-React**: hay que usar
  el React/hooks que llegan por props, no importar otro React (panels.d.ts:45-65).
- host.snapshot() se lee en render. El adaptador recrea host cuando cambian
  channel/activity/attention/focused (components/sidePanel/pluginPanelAdapter.js:57-122),
  así que los cambios de la sesión provocan re-render.
- Para datos externos (p. ej. ficheros de dsh-workers) el único temporizador legítimo es
  ui.useAnimationTime(ms); con null se pausa. No hay setInterval propio permitido.
- host.onKey(...) solo entrega eventos mientras el panel tiene foco y es visible; preventDefault()
  evita que el host procese la tecla de vuelta (pluginPanelAdapter.js:33-51, 117-120).
- host.focus() pide foco; host.notify()/clearBadge() actualizan el badge de la pestaña.
- host.toast() y host.openScene(id) son las únicas acciones de UI; openScene solo abre escenas
  registradas por el propio plugin.

### 2.4 Límites duros de esta versión (importantes)

| Límite | Evidencia | Impacto |
| --- | --- | --- |
| compact solo se valida, **no se monta** | plugins.en.md:56-58; panels.js:243-244 | No hay vista compacta al colapsar la barra |
| sendToChat() siempre false + toast único | panels.d.ts:124-128; pluginPanelAdapter.js:107-113 | No se puede adjuntar un job al composer |
| Sin acceso a ChannelUi/jobControl/subagentControl | pluginPanelAdapter.js:6-16; contexto interno del side panel | No kill/steer/attach; solo snapshot |
| mountPolicy forzado a active | panels.js:240-241 | El panel se desmonta al cambiar de pestaña (pierde scroll/estado) |
| 3 crashes en 60 s → panel deshabilitado por sesión | PanelStore.js:3-5, 90-112 | Un bug de render deja el panel en “disabled” hasta reiniciar |
| open() limitado a 1 vez / 5 s por plugin | panels.js:46-47, 309-317 | No hacer bucles de apertura |
| Costura experimental | plugins.en.md:40 | Puede cambiar en minors; apiVersion exacta |

Además, el layout necesita **≥93 columnas de contenido** (64 de chat + 28 de panel + 1 de separador;
`dimensions.js:19-32`); el hint de i18n añade que la barra requiere fullscreen (i18n.js:2278). Si no
cabe, la PanelBar existe pero el host muestra “too narrow”.

---

## 3. Paneles nativos: existen y se pueden imitar, pero no reutilizar

components/sidePanel/builtinPanels.js:173-272 registra **ocho** paneles built-in:

| id | icono | orden | capacidades |
| --- | --- | --- | --- |
| todo | ≡ | 10 | — |
| info | ⓘ | 15 | scroll |
| jobs | ▸ | 20 | scroll, sendToChat, fullscreen |
| btw | ? | 22 | scroll, sendToChat, fullscreen |
| trajectory | ∿ | 25 | scroll, fullscreen |
| agents | ◆ | 30 | scroll, fullscreen |
| workspace | ⌗ | 35 | scroll, fullscreen |
| companion | ♥ | 40 | — |

jobs (builtinPanels.js:187-199) y agents (200-211) son los análogos directos de “Agent
Workers”. Pero **no se pueden importar ni reutilizar**: usan useSidePanelChannel()
(builtinPanels.js:22,50,117), un contexto interno que aporta channel.backgroundJobs,
jobControl, subagentControl, etc. Ese contexto **no está en exports** (solo ./panels,
./api, ./extensions, ./scenes, ./jsx-runtime, ./plugin-host), y el adaptador de plugins
entrega únicamente el snapshot curado. La conclusión es: se **imita la UI**, no se hereda la lógica.

Los built-ins se registran directamente en el PanelStore de proceso
(components/sidePanel/PanelStore.js), que es el mismo registro al que entra el panel del plugin tras
pasar la admisión de TuiPanelRuntime. El orden final pone siempre los built-ins primero
(PanelStore.js:6-16), así que un plugin con order: 50 aparece después.

### UX existente que el panel hereda gratis

- Ctrl+B abre/cierra/enfoca la barra lateral (README.md:38; useSidePanel.d.ts:32-35).
- Estando enfocado el panel: ←/→ o [/] cambian de panel, 1-9 salta a un id del CSV,
  z hace zoom, +/- ajusta el ancho, Esc vuelve al chat (useSidePanel.js:194-231).
- /panel, /panel toggle|focus|zoom|<id> (useSidePanel.js:125-161; commands.js:67).
- La lista de paneles habilitados se edita en /settings → dsh-tui.sidePanel.panels
  (settings/definitions.js:270-277), y los paneles de plugin “appear here automatically”.

---

## 4. Cómo se haría: receta mínima de plugin

### 4.1 Estructura del paquete

~~~text
dsh-tui-agent-workers/
  package.json
  dsh-plugin.json
  cordis.patch.yml
  lib/index.js          # ESM, sin build (o tsc a lib/)
~~~

**package.json**

~~~json
{
  "name": "dsh-tui-agent-workers",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "dsh-plugin.json", "README.md"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "engines": { "node": ">=24" }
}
~~~

**dsh-plugin.json** — admisión e identidad. El id debe ser un slug estable; si lleva puntos, el
host cae en un prefijo actN por proceso (ver §7):

~~~json
{
  "$schema": "https://dsh.community/schemas/dsh-plugin-0.15.json",
  "id": "agent-workers",
  "name": "Agent Workers panel",
  "version": "0.1.0",
  "manifestVersion": "0.15",
  "facets": {
    "host": { "entry": "lib/index.js", "apiVersion": "v1alpha1" }
  },
  "requires": { "contracts": [] },
  "permissions": [],
  "contributes": { "commands": [] },
  "subscriptions": [],
  "license": "MIT"
}
~~~

> Verificado con el parser instalado (@dsh-std/manifest): agent-workers pasa parseManifest y
> projectManifest, y metadata.name = "agent-workers", que sí cumple el regex de pluginIdFor
> (/^[a-z][a-z0-9_-]*$/). Un id canónico con puntos
> (dsh-tui-ecosystem.agent-workers) también es válido como manifiesto, pero **no** como prefijo de
> panel: cae en act1, act2, … (panels.js:60-72).

**cordis.patch.yml** — inserta la fila del plugin en el perfil:

~~~yaml
- insert:
    - id: dsh-tui-agent-workers
      name: 'dsh-tui-agent-workers'
~~~

### 4.2 Código mínimo del panel

~~~js
// lib/index.js
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-tui-agent-workers'

const STATE_DIR = process.env.DSH_WORKERS_STATE_DIR
  ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'dsh-workers')

/** Lee job.json de dsh-workers; nunca arranca el servidor MCP (ver §5.3). */
async function readWorkers() {
  let entries
  try {
    entries = await readdir(join(STATE_DIR, 'jobs'), { withFileTypes: true })
  } catch {
    return []
  }
  const rows = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const j = JSON.parse(await readFile(join(STATE_DIR, 'jobs', entry.name, 'job.json'), 'utf8'))
      rows.push({
        id: j.id,
        label: j.label ?? j.id,
        status: j.status ?? 'unknown',
        steps: j.steps ?? 0,
        cost: j.costUsd ?? 0,
        startedAt: Date.parse(j.startedAt ?? j.createdAt ?? '') || 0,
      })
    } catch {
      // job.json a medio escribir: se ignora en este tick
    }
  }
  return rows.sort((a, b) => b.startedAt - a.startedAt).slice(0, 20)
}

function AgentWorkersPanel({ React, ui, host, width, height, visible }) {
  const tick = ui.useAnimationTime(visible ? 1000 : null)
  const [workers, setWorkers] = React.useState([])
  const [error, setError] = React.useState(null)

  React.useEffect(() => {
    if (!visible) return
    let alive = true
    readWorkers().then(
      rows => { if (alive) { setWorkers(rows); setError(null) } },
      err => { if (alive) setError(String(err?.message ?? err)) },
    )
    return () => { alive = false }
  }, [visible, tick])

  const snap = host.snapshot()
  const running = snap.backgroundJobs.filter(j => j.status === 'running' || j.status === 'stopping')
  const liveWorkers = workers.filter(w => ['running', 'queued', 'starting'].includes(w.status))

  React.useEffect(() => {
    if (!visible) return
    if (liveWorkers.length > 0) host.notify('info', liveWorkers.length)
    else host.clearBadge()
  }, [visible, liveWorkers.length])

  const max = Math.max(8, width - 2)
  const lines = [
    'dsh-workers: ' + workers.length + ' (' + liveWorkers.length + ' live)',
    ...workers.map(w => (w.status === 'running' ? '▶ ' : '· ') + w.label + ' [' + w.status + '] ' + w.steps + ' steps'),
    '',
    'this session: ' + running.length + ' background job(s)',
    ...running.slice(0, 5).map(j => '  ' + j.status + ' ' + (j.label || j.id) + (j.progress ? ' ' + j.progress : '')),
  ]
  if (error) lines.push('error: ' + error)

  return React.createElement(
    ui.Box,
    { flexDirection: 'column', paddingX: 1 },
    ...lines.slice(0, Math.max(1, height)).map((line, i) =>
      React.createElement(ui.Text, { key: i }, line.length > max ? line.slice(0, max - 1) + '…' : line),
    ),
  )
}

export function apply(ctx) {
  ctx.inject(['tuiPanels'], (scoped) => {
    const panels = scoped.get('tuiPanels', false)
    if (!panels) return
    const dispose = panels.register({
      apiVersion: 1,
      id: 'workers',          // id final: '<pluginId>:workers'
      title: 'Agent Workers',
      icon: 'W',              // ancho 1
      minColumns: 32,
      order: 50,
      component: AgentWorkersPanel,
    }, scoped)
    if (typeof dispose === 'function' && typeof scoped.effect === 'function') {
      scoped.effect(() => dispose)
    }
  })
}
~~~

Puntos deliberados del snippet:

- ctx.inject(['tuiPanels'], ...) espera a que el servicio esté montado (mismo patrón que
  dsh-tui-quotas con tuiScenes/tuiStatus; ver projects/dsh-tui-plugins/dsh-tui-quotas/src/index.ts:237-250).
- register(..., scoped) pasa la identidad de la activación; el servicio la valida
  (host-access.js:756-772).
- El dispose se ata con scoped.effect, de modo que descargar/recargar el plugin retira el panel.
- No se importa React ni componentes internos: se usan props.React y props.ui.
- El id final lleva prefijo. Para descubrirlo en runtime: panels.list() devuelve
  { id, title, source } de los paneles propios (panels.d.ts:196-200, 231).
- No se usa setInterval; ui.useAnimationTime es el temporizador permitido.

### 4.3 Instalación en el perfil (sin tocar el repo de dsh-tui)

El patrón ya probado en esta máquina por dsh-tui-quotas y dsh-tui-stt:

1. Publicar o enlazar el paquete. En ~/.dsh/profiles/dsh-tui/package.json:

   ~~~json
   "dependencies": {
     "dsh-tui-agent-workers": "link:/home/cesardiaz/projects/dsh-tui-plugins/dsh-tui-agent-workers"
   },
   "dsh": { "profile": { "bundles": [
     "@deepseek-ai/dsh-base",
     "@deepseek-harness-tui/dsh-tui",
     "dsh-tui-stt",
     "dsh-tui-quotas",
     "dsh-tui-agent-workers"
   ] } }
   ~~~

   (el symlink resultante está en ~/.dsh/profiles/dsh-tui/node_modules/dsh-tui-agent-workers).
2. cd ~/.dsh/profiles/dsh-tui && pnpm install (el perfil ya es un workspace pnpm:
   pnpm-workspace.yaml, pnpm-lock.yaml).
3. Alternativa oficial dentro de la TUI: /plugin install <spec> / dsh plugin add escriben
   dsh.profile.bundles y pasan por la admisión y el aviso de confianza
   (plugins.en.md:67-71, 84-99). Para un directorio local, el patrón link: es el que ya
   funciona en este equipo.
4. Reiniciar dsh-tui. El panel se auto-habilita y aparece en la PanelBar; Ctrl+B lo abre.
   No hace falta editar sidePanel.panels a mano (aunque /settings lo muestra y permite quitarlo).

### 4.4 Verificación

- dsh-tui doctor → perfil/launcher alineados.
- /plugin list → el bundle aparece.
- Ctrl+B → pestaña “Agent Workers”; z zoom; Esc vuelve al chat.
- Si el panel no aparece: mirar warnings dsh-tui: tuiPanels.register rejected ... en el log; las
  causas están enumeradas en panels.js:162-230.
- Si el panel crashea 3 veces en 60 s, el host lo deshabilita por sesión (panel-plugin-disabled).

---

## 5. Datos para “Agent Workers”

### 5.1 Lo que ya te da la sesión TUI

host.snapshot() expone backgroundJobs y subagents de **esta** sesión. En el caso DSH, esos
rostros los alimentan los servicios del host DSH (la proyección neutral de channel/activity.js:1-13
dice explícitamente que “A DSH session never reaches it: the DSH specialists keep their own
projections fed by the DSH host services”). Es decir: jobs de background y subagentes **lanzados por
esta sesión** sí; procesos externos no.

### 5.2 Workers de dsh-workers (procesos headless separados)

dsh-workers guarda un registro en disco, sin daemon:

- Directorio por defecto: $XDG_STATE_HOME/dsh-workers o ~/.local/state/dsh-workers
  (projects/dsh-workers/src/config.ts:114-118), override DSH_WORKERS_STATE_DIR
  (config.ts:134-135).
- Un jobs/<id>/job.json por job (más events.ndjson, final.md, stderr.log).
- Campos útiles observados en un job real: id, label, groupId, groupName, status,
  reason, steps, toolCalls, lastTool, usage, costUsd, createdAt, startedAt,
  finishedAt, sessionId, profile, provider, model.
- JobSummary completo en projects/dsh-workers/src/types.ts:74-103.
- El dashboard standalone (dsh-workers-ui, package.json:8-11) lee exactamente esos ficheros
  (src/dashboard.ts:1-39); un panel puede hacer lo mismo.

Para el panel, un lector read-only de job.json + un tick de 1 s es suficiente para estado,
progreso (steps/lastTool) y coste. Para “tail” de eventos se puede leer events.ndjson
incrementalmente, pero es más caro; el snapshot de la sesión no lo necesita.

### 5.3 Trampa importante: no arrancar un segundo dsh-workers

JobManager.loadPreviousJobs() (jobs.ts:392-421) recorre jobs/*/job.json; si encuentra un job
**no terminal** y el PID sigue vivo, **mata el árbol de procesos** y lo marca interrupted. Es
decir, lanzar node dist/server.js desde el panel para “consultar estado” puede matar los workers
reales. El panel debe leer ficheros, no montar otro servidor MCP.

Las acciones (dsh_cancel, dsh_steer) viven en el servidor MCP del padre, no en el panel. La API
TuiPanelHostApi no ofrece jobControl, y sendToChat está deshabilitado. Si se quieren botones
de cancelar/steer dentro del panel, hay que diseñar un canal propio (por ejemplo, un fichero de
comandos que el servidor del padre consuma, o un socket/IPC) y asumir el riesgo; no es lo que ofrece
la API en 0.16.1.

### 5.4 pi

En este equipo pi 1.3.0 existe (~/.pi/agent/...), pero no se ha encontrado un registro de jobs
equivalente: ~/.pi/agent/pi-subagents solo contiene last-seen-version.json, y no hay
jobs/*/job.json ni un daemon consultable. Si “jobs de pi” significa workers de pi, el panel
necesitaría un **productor de estado** (hook/extensión de pi que escriba un job.json similar) o
una API de pi que aquí no está documentada. Si “pi” se refiere al proveedor pi-ai de DSH, son
llamadas de modelo, no jobs de worker. Conviene aclarar este punto antes de implementar.

---

## 6. Opciones concretas

| Opción | ¿Qué es? | ¿Sirve? | Esfuerzo | Riesgo |
| --- | --- | --- | --- | --- |
| **A. API oficial ctx.tuiPanels** | Plugin Cordis que registra un TuiPanelDescriptor con componente React | **Sí, recomendada** para panel read-only | 4–8 h MVP; 1–2 d pulido | Medio: costura experimental; sin acciones |
| **B. Contribución por config / paquete npm** | sidePanel.panels solo habilita IDs; el paquete/bundle es el vehículo de A | **Parcial**: no define paneles por sí solo; es cómo se distribuye A | ~15 min instalar | Bajo si se usa link:/npm; medio si se edita el perfil a mano |
| **C1. Fork/parche de dsh-tui** | Modificar PanelHost/builtinPanels para añadir un panel nativo con jobControl | Sí, pero caro | Días-semanas + mantenimiento por release | Alto: conflictos en cada upgrade, se pierde la admisión |
| **C2. Panel externo (herdr/tmux) + dashboard** | dsh-workers-ui en un pane al lado de la TUI, o un dashboard web | Sí, sin tocar dsh-tui | Horas | Bajo técnico; nulo integración (no comparte foco/badge) |

**Recomendación:** A + B. Un paquete dsh-tui-agent-workers enlazado en el perfil, panel read-only
con snapshot + lectura de job.json, badge de “live workers”, y teclas propias (r refrescar,
Enter abrir detalle en una escena propia si se quiere). Dejar C1 para el día que se necesiten
acciones integradas o un panel en otra posición (izquierda/abajo); hoy la API solo pinta a la derecha.

---

## 7. Riesgos y trampas concretas

1. **Experimental, no “stable candidate”.** plugins.en.md:39-41 separa las costuras estables
   (settings, scenes, dialogs, status, shortcuts, renderers) de las experimentales (decision events,
   toast, **side panels**). Un minor puede cambiar la forma; apiVersion debe coincidir exactamente.
2. **Prefijo de id inestable con manifiestos “canónicos”.** pluginIdFor (panels.js:60-72) solo
   acepta /^[a-z][a-z0-9_-]*$/. Un id con puntos (el formato que usa el template oficial:
   dsh-tui-ecosystem.example-plugin) hace que el host use act1, act2, … como prefijo. Eso
   cambia el id final entre procesos y puede dejar IDs huérfanos en el CSV sidePanel.panels.
   **Solución:** manifiesto con id de una sola pieza con guiones (agent-workers) o descubrir el id
   con panels.list() y no hardcodearlo.
3. **Sin control de jobs.** No hay kill/steer/attach; sendToChat devuelve false. Un panel
   “de verdad” para operar workers necesita un canal propio o fork.
4. **mountPolicy: 'active'.** Al cambiar de pestaña el componente se desmonta; se pierde el estado
   local (scroll, selección). Los built-ins conservan estado porque usan enabled; los plugins no
   pueden elegirlo.
5. **Ancho mínimo.** La barra lateral exige fullscreen y ≥93 columnas de contenido; por debajo, el
   panel no se puede mostrar. minColumns del descriptor (12–64, default 28) es otro gate.
6. **Crash isolation.** 3 crashes en 60 s deshabilitan el panel por sesión; el chat sigue vivo.
   Hay que envolver lecturas/parseos en try/catch y no lanzar en render.
7. **Datos externos frágiles.** job.json es un formato interno de dsh-workers 0.3.6; puede
   cambiar. Leer de forma tolerante (campos opcionales, JSON a medio escribir) y nunca bloquear el
   render con I/O síncrona.
8. **No arrancar el servidor dsh-workers desde el panel** (§5.3): puede matar workers vivos.
9. **Aviso de la propia skill de dsh-workers:** “Do not claim these workers appear in Claude's native
   subagent panel or the DSH TUI side panel. They are separate DSH headless processes.”
   (projects/dsh-workers/skills/dsh-parallel/SKILL.md:162-168). El panel puede **mostrar** su estado
   leyendo disco, pero no son “subagentes de la sesión” ni aparecen por arte de magia en el snapshot.
10. **Instalación y confianza.** /plugin install tiene aviso de procedencia y confirmación; un
    link: local evita la red pero sigue siendo código que corre en el proceso de la TUI. Revisar el
    paquete antes de instalarlo.

---

## 8. Qué habría que construir (checklist)

- [ ] Paquete dsh-tui-agent-workers con package.json, dsh-plugin.json, cordis.patch.yml,
      lib/index.js (ESM; sin build o tsc).
- [ ] Lector read-only de ~/.local/state/dsh-workers/jobs/*/job.json con orden por startedAt,
      filtro de estados y límite de filas.
- [ ] Componente que combine:
      - host.snapshot().backgroundJobs / .subagents (sesión TUI),
      - workers externos (ficheros),
      - badge host.notify('info', live) / clearBadge().
- [ ] Temporizador ui.useAnimationTime(1000) solo cuando visible; sin setInterval.
- [ ] Manejo de errores por fila y por tick; nada de throws en render.
- [ ] (Opcional) host.onKey: r refrescar, Enter detalle, o abrir escena propia con
      host.openScene('workers-detail').
- [ ] (Opcional) escena de detalle con ctx.tuiScenes.register (mismo patrón que
      dsh-tui-quotas/src/scene.ts), para ver events.ndjson o el final.md.
- [ ] (Opcional) comando /workers con ctx.commands.register + contribución Command en el
      manifiesto; no es necesario para que el panel aparezca.
- [ ] Tests unitarios del lector con fixtures de job.json; test de render con un host mock.
- [ ] Instalación link: + pnpm install en el perfil; verificación con Ctrl+B y /settings.

---

## 9. Índice de evidencia (rutas y líneas)

### dsh-tui 0.16.1

| Qué | Dónde |
| --- | --- |
| Exports ./panels, ./api, ./extensions, ./scenes, ./jsx-runtime | package.json:76-99 |
| Constantes y tipos del panel | lib/types/dsh-adapter/panels.d.ts:26-176, :222-229 |
| Implementación de register() (validación, prefijo, budgets, auto-enable, dispose) | lib/types/dsh-adapter/panels.js:131-274 |
| Prefijo pluginId y fallback actN | lib/types/dsh-adapter/panels.js:60-72 |
| Snapshot curado (jobs/subagentes) | lib/types/dsh-adapter/panels.d.ts:76-116 |
| Host API (sendToChat false, onKey, focus, notify) | lib/types/dsh-adapter/panels.d.ts:118-138 |
| Adaptador React del panel (snapshot, teclado, single-React) | lib/types/components/sidePanel/pluginPanelAdapter.js:28-148 |
| Fila del servicio dsh-tui-panels | cordis.patch.yml:291-295 |
| La app inyecta tuiPanels | cordis.patch.yml:407-411 |
| Guard de desalineación del perfil | lib/types/dsh-adapter/plugin.js:439-446 |
| Config sidePanel (splitEnabled/open/ratio/panels) | lib/types/dsh-adapter/plugin.js:1133-1145 |
| Settings sidePanel.panels (los paneles de plugin aparecen solos) | lib/types/settings/definitions.js:270-277 |
| Paneles built-in y sus registros | lib/types/components/sidePanel/builtinPanels.js:173-272 |
| jobs built-in | lib/types/components/sidePanel/builtinPanels.js:187-211 |
| Crash isolation (3/60 s) | lib/types/components/sidePanel/PanelStore.js:3-5, :90-112 |
| mountPolicy / props de panel | lib/types/components/sidePanel/types.d.ts:9-60 |
| /panel y teclas | lib/types/components/sidePanel/useSidePanel.js:125-161, :194-231 |
| Guía: costura experimental y límites | guide/dsh-tui-guide/plugins.en.md:39-59 |
| README: side panel y Ctrl+B | README.md:38 |
| Ancho mínimo 93 columnas (64+28+1) | lib/types/components/sidePanel/dimensions.js:19-32; i18n.js:2278 |
| Datos de actividad de la sesión | lib/types/channel/activity.js:1-13 |

### Perfil vivo

| Qué | Dónde |
| --- | --- |
| Bundles y plugins enlazados | ~/.dsh/profiles/dsh-tui/package.json:4-17 |
| Capa de usuario (sin paneles) | ~/.dsh/profiles/dsh-tui/cordis.patch.yml:1-40 |
| Symlinks de plugins | ~/.dsh/profiles/dsh-tui/node_modules/dsh-tui-{quotas,stt} |
| Patrón ctx.inject(['tuiScenes']) y register(..., scoped) | projects/dsh-tui-plugins/dsh-tui-quotas/src/index.ts:237-250 |
| Escena de ejemplo | projects/dsh-tui-plugins/dsh-tui-quotas/src/scene.ts:9-74 |

### dsh-workers (fuente de datos)

| Qué | Dónde |
| --- | --- |
| JobSummary | projects/dsh-workers/src/types.ts:74-103 |
| Directorio de estado | projects/dsh-workers/src/config.ts:114-118, :134-135 |
| job.json y carga de jobs (peligro de matar vivos) | projects/dsh-workers/src/jobs.ts:392-421 |
| Dashboard que lee los mismos ficheros | projects/dsh-workers/src/dashboard.ts:1-39 |
| Bins dsh-workers / dsh-workers-ui | projects/dsh-workers/package.json:8-11 |
| Aviso: no aparecen en el side panel de DSH | projects/dsh-workers/skills/dsh-parallel/SKILL.md:162-168 |

### Comprobaciones ejecutadas

- dsh-tui version → 0.16.1 launcher y perfil.
- dsh-tui doctor → perfil 0.16.1, launcher alineado, config en
  ~/.dsh/profiles/dsh-tui/cordis.patch.yml.
- parseManifest/projectManifest sobre un manifiesto mínimo con id: "agent-workers" → OK,
  metadata.name = "agent-workers".
- No se ejecutó la TUI interactiva; no se modificó dsh-workers ni ~/.dsh.

---

## 10. Conclusión

La respuesta a “¿hay API?” es **sí**: ctx.tuiPanels en 0.16.1, experimental, con descriptor,
componente React, snapshot curado, badge, foco y teclado. La forma correcta de usarla es un plugin
Cordis empaquetado como bundle y declarado en dsh.profile.bundles; no hay atajo declarativo en
config. Para “Agent Workers” se puede construir un panel útil en menos de un día leyendo el snapshot
de la sesión y los job.json de dsh-workers; las acciones de operación (cancelar/steer) quedan
fuera de la API y exigirían un canal propio o un fork. El riesgo es acotado y el coste de
mantenimiento bajo mientras se acepte que la costura es experimental.
