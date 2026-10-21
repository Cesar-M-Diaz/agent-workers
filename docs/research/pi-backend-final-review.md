# Review final: feat/pi-backend (a87c3af..408d9f9) y decisión de repo para dsh-tui

Worktree: `/home/cesardiaz/projects/dsh-workers-pi` (HEAD 408d9f9). No modifiqué nada y el árbol quedó limpio.

Repros, fuera del repo:
- `/tmp/claude-1000/-home-cesardiaz-projects-dsh-workers/e37547a2-3f88-438f-b5c0-08a2148ac4c1/scratchpad/final-review/state.ts`
- `/tmp/claude-1000/-home-cesardiaz-projects-dsh-workers/e37547a2-3f88-438f-b5c0-08a2148ac4c1/scratchpad/pi-review/repro.ts`

Contraste con pi 1.3.0 instalado: `dist/main.js`, `dist/cli/args.js` y `dist/core/agent-session.js`.

## Checks
- vitest: 77/77. Hay que correrlo con `--exclude 'tests/**'`, como hace `pnpm test`; sin el exclude, vitest intenta cargar `tests/pane.test.tsx`.
- `claude plugin test .`: 44/44.
- tsc: 0 errores.
- biome: 0 errores (40 infos preexistentes).
- `bundle --check`: al día.
- `claude plugin validate .`: ✔.
- `git status`: limpio.

## Veredicto
**Mergear con fixes.**
- 1 BLOCKER nuevo, introducido por el rename: el state dir legacy no se usa y el MCP no arranca tras un upgrade.
- 1 MAJOR: B1 tiene un caso nuevo de pérdida de sesión.

Los dos fixes son pequeños. Todo lo demás de B1 y M1 a M4 está bien resuelto y el rename es consistente.

## BLOCKER

**N1. El server nunca usa `~/.local/state/dsh-workers`, y con `state_dir` vacío el MCP no arranca tras el upgrade.**
- **Dónde:** `src/config.ts:140`. En `defaultStateDir()` se calcula `legacy = join(base, 'agent-workers')`, así que ambas ramas devuelven `agent-workers` (`config.ts:140-147`).
- **Contradicción con la documentación:** `docs/MIGRATION.md` ("State directory") y `README.md:136,151,168` dicen que se reutiliza el dir legacy si existe.
- **Por qué es el caso por defecto:** `pluginConfigs` no migra, así que tras instalar el plugin nuevo `state_dir` queda vacío.
- **Efecto:** el server crea `agent-workers/` y los perfiles dsh, que viven en `<state>/dsh-home/profiles`, desaparecen.
  - `JobManager.init` lanza `unknown_profile unknown profile work-openrouter; available: none`. El fallback de M3 no aplica, porque solo actúa cuando hay perfil configurado (`jobs.ts:322-347`).
  - Repro: `state.ts` con un HOME temporal que contiene `dsh-workers/`.
  - Es justo el caso de esta máquina: en `~/.local/state` solo existe `dsh-workers`, con `personal-deepseek`, `personal-opencode` y `work-openrouter`.
- **Efectos secundarios:**
  - Los jobs y worktrees viejos quedan invisibles y no los poda nadie.
  - El pane (`hooks/register.tsx`, `resolveStateDirFor`) prefiere el dir nuevo si existe y luego el legacy. Antes de que arranque el server muestra los jobs viejos; después, ninguno.
- **Fix:**
  1. `legacy = join(base, 'dsh-workers')`.
  2. Usar el mismo orden en server y pane: legacy si existe, si no el nuevo, como dice MIGRATION.
  3. Agregar un test del lado del server. El test actual solo cubre el pane (`tests/pane.test.tsx:474-478`).

## MAJOR

**N2. B1 tiene un caso nuevo: borrar el job original se lleva la sesión de sus descendientes.**
- **Dónde:** el resume hereda `sessionDir = original.sessionDir ?? original.dir` (`jobs.ts:619`, `fromPersisted`).
  - Toda la cadena A→B→C escribe en `A/pi-sessions`.
  - `JobManager.delete` (`jobs.ts`, `async delete`) no revisa referencias. `deleteJobRecord` hace `rm -rf` del dir del job (`admin.ts:61`), y `pruneExpiredJobs` lo poda por retención (`admin.ts:159-163`).
- **Efecto:** al resumir o steerear C después de borrar A, pi no encuentra el id y crea una sesión nueva vacía sin avisar (`main.js:344-351`). Es el B1 original otra vez.
- **Por qué es probable:** el original steereado queda terminal (`cancelled/steered`). La skill exige limpiar y el pane ofrece borrar con dos pasos.
- **Fix, de menor a mayor esfuerzo:**
  1. Preflight en resume: si no hay `*.jsonl` con ese id en `sessionDir`, responder `resume_unavailable`.
  2. `session_busy`: rechazar delete y prune mientras otro job no borrado referencie ese `sessionDir`. Es el mismo mecanismo que `worktree_busy` (riesgo #2 del research), que hoy también falta para el worktree compartido tras un steer de dsh.
  3. `--fork <sesión original>` hacia el dir propio del job nuevo, para que cada job sea dueño de su sesión.
- **Test:** steer seguido de delete del original y luego steer del descendiente.

## MINOR
- **Rename del marketplace sin probar contra instalaciones existentes.** `.claude-plugin/marketplace.json` cambió el nombre de `dsh-workers` a `agent-workers`, pero las instalaciones actuales registraron el marketplace como `dsh-workers` y el shim depende de `claude plugin update dsh-workers@dsh-workers`. Antes del release, probarlo con un `CLAUDE_CONFIG_DIR` limpio que tenga 0.3.6 instalado, y documentar si hace falta volver a agregar el marketplace.
- **El aviso del shim puede no verlo el usuario.** El shim (`legacy/dsh-workers/notify.mjs`) escribe texto plano en SessionStart, que va al contexto del modelo y no necesariamente a la pantalla. Conviene emitir JSON con `systemMessage`.
- **Cambio de API no documentado.** `status.server.dsh_version` pasó a `engine_version` (`jobs.ts:460`, `types.ts:139`) y no figura en MIGRATION.
- **Fallback de env distinto en el pane.** El pane usa `AGENT_WORKERS_STATE_DIR ?? DSH_WORKERS_STATE_DIR`, y un valor `""` bloquea el fallback. El server (`readEnv`, `config.ts:37-49`) sí trata los vacíos como no definidos.
- **Nombres viejos en el research.** El plan de dsh-tui todavía usa `dsh-workers-control/1`, `DSH_WORKERS_CONTROL` y "dsh-workers 0.4.0", pero 0.4.0 ya es el rename. El control API debería ser `agent-workers-control/1` en la 0.5.0.

## NIT
- **Helper de env duplicado:** `workerEnv` (`jobs.ts:40`) repite lo que hace `readEnv` (`config.ts:37`).
- **Exclude fuera de la config:** el `--exclude 'tests/**'` vive en el script `test`; ponerlo en la config de vitest evita el falso FAIL al correrlo directo.

## Verificado correcto
- **B1:** queda resuelto salvo N2.
  - `sessionDir` se persiste.
  - `fromPersisted` cae al dir propio para jobs viejos, lo cual es correcto porque los jobs pi previos usaban `job.dir`.
  - `sessionLocks` impide dos resumes concurrentes.
  - Resume y steer pasan por `supportsResume`; el steer cancela el original antes.
  - Hay test de resume/steer.
- **M1:** el error se limpia en `auto_retry_start` y en `agent_end{willRetry:true}`. `auto_retry_end{success:false}` fija `finalError`, y el último intento fallido vuelve a fijarlo vía `message_end`, así que no enmascara errores finales. Hay fixtures `json-retry` y `json-retry-failed`.
- **M2:** `taskInput:'stdin'`. pi lee el stdin entubado como texto del prompt sin interpretar `@` ni `-` (`main.js:52-67,726-733`). El fake pi registra stdin y argv.
- **M3:** con un perfil configurado desconocido cae al default del engine y lo reporta por stderr (`profile_fallback`); con un perfil válido no cambia nada. Hay test.
- **M4:** read-only por defecto. `assertBackendAccess` se aplica a jobs nuevos y a resumes. `pi_allow_write` está en `plugin.json` y `.mcp.json`; con escritura, el toolset y el worktree se mantienen.
- **Rename:**
  - plugin id `agent-workers` 0.4.0, alineado en `plugin.json`, `package.json` y `version.ts`
  - server key `agent-workers`
  - 11 tools `worker_*`
  - 13 comandos sin prefijo, incluido `migrate`
  - skill `parallel`
  - pane: id, namespace de storage y candidatos del server
  - `AGENT_WORKERS_*` con fallback a `DSH_WORKERS_*`; la profundidad se exporta con ambos nombres
  - shim sin MCP
  - MIGRATION cubre las reglas de permisos
  - Sin referencias stale fuera de docs, migrate y legacy.
- **MINOR previos resueltos:** se usa `errorMessage` de pi; `:free` ya no se toma como thinking; `${backend} exited`; `costOf` solo usa el coste reportado si es mayor que 0; `byId` lanza con backends desconocidos; los errores del archivo de perfiles se loguean; `length` se reporta como `turn_error` conservando el final.

## Huecos de tests que importan
1. **State dir legacy en el server.** Habría detectado N1.
2. **Delete/prune de un ancestro seguido de resume.** Cubre N2.
3. **Cancelación de un job pi en curso.**
4. **Upgrade end-to-end del marketplace y el shim**, manual con un `CLAUDE_CONFIG_DIR` limpio.

## dsh-tui repo decision

### Lo que condiciona la decisión
- **Runtimes distintos.**
  - El panel de dsh-tui es un bundle ESM Cordis: `package.json` con `dsh.bundle.patch`, `dsh-plugin.json` y `cordis.patch.yml`. Debe usar el React y el kit `ui` que llegan por props, sin traer React propio, y se ata a la API experimental `tuiPanels` v1 (dsh-tui ≥0.16.1 <0.17).
  - El plugin de Claude es otro mundo: mod de Claude Code, `plugin-dist` bundleado y `userConfig`.
  - No comparten build ni dependencias de runtime.
- **Lo que sí comparten:**
  - el read model, es decir el esquema de `job.json` y de los eventos
  - el control protocol v1, que vive en agent-workers
  - las funciones puras de vista de `hooks/jobs.ts` (sanitizado ANSI, normalización y formato)
- **Velocidad de cambio:** el protocolo va a cambiar mucho en las fases 0 a 3 y después se congela. El panel cambia con cada release de dsh-tui.

### Evaluación
- **A. Mismo repo, subpaquete propio.**
  - **A favor:** un PR cambia server y panel a la vez; el panel puede importar los tipos del protocolo (type-only, se borran al compilar); hay un test de contrato end-to-end en un solo CI (control server con fake dsh/pi y el cliente del panel); los usuarios lo encuentran junto al plugin; y repo público.
  - **En contra:** el plugin de Claude copia el subdir al instalarse (peso, sin efecto funcional); hay que excluirlo del tooling raíz (biome, vitest, tsc, bundle); y no está verificado que `/plugin install <git url>` de dsh-tui admita subdirectorios (con `link:` o npm no hay problema).
- **B. Monorepo `packages/core` + plugin Claude + plugin dsh-tui.**
  - Obliga a mover la raíz del plugin de Claude y el `source` del marketplace justo después del rename: una segunda migración para los usuarios.
  - Un `core` compartido sin consumidores estables es abstracción prematura.
  - Hoy no compensa.
- **C. Repo separado.**
  - Ya existe `~/projects/dsh-tui-plugins`, un workspace pnpm con `dsh-tui-quotas` y `dsh-tui-stt`, el patrón `link:` probado y el pin común de dsh-tui. Es buen hogar a largo plazo para todo lo que dependa de la API de dsh-tui.
  - **En contra:** no tiene remote y sus paquetes son `private`; el protocolo churnea entre dos repos con versiones cruzadas; y el test de contrato end-to-end exige clonar los dos.

### Recomendación: A ahora, con salida a C cuando el protocolo se congele

1. **Ubicación:** `integrations/dsh-tui/`, con el paquete `dsh-tui-agent-workers`.
   - Tiene su propio `package.json`, lockfile, `tsconfig` y build a `lib/`. No se agrega un `pnpm-workspace` en la raíz ni se toca el plugin raíz.
   - React queda solo en `devDependencies`/types, y el runtime lo recibe por props.
2. **Qué se comparte:**
   - los tipos de `src/control/protocol.ts`, por import type-only
   - un fixture de state dir (`test/fixtures/state/`) que usan el pane, el dashboard y el panel
   - las funciones puras de vista se duplican lo mínimo (sanitizado y formato) y se cubren con tests de contrato, como sugiere el research; solo se extraen si aparece drift
3. **CI:** un job aparte con path filter `integrations/dsh-tui/**` y `src/control/**`, más un test de contrato que levanta el control server real.
4. **Versionado:** tags independientes: `v0.5.0` para el plugin y `dsh-tui-v0.1.0` para el panel. El README del panel incluye una matriz de compatibilidad (agent-workers ≥0.5 y dsh-tui 0.16.x) y el panel hace feature-detect de `tuiPanels`.
5. **Secuencia:**
   1. Arreglar N1 y N2 y publicar 0.4.0 sin control API.
   2. Fase 0: `docs/control-protocol.md` (`agent-workers-control/1`) y el fixture de state dir.
   3. Fase 1, en la raíz: control HTTP loopback, owner leases, `worktree_busy` y `session_busy` (cubre N2 de raíz), con env `AGENT_WORKERS_CONTROL`. Se publica como 0.5.0.
   4. Fase 2: panel read-only en `integrations/dsh-tui` 0.1.0, instalado con `link:` en el perfil. No se publica.
   5. Fase 3: acciones (cancel, cleanup y delete con lease y busy checks) y steer en escena. Con el protocolo v1 congelado, publicar en npm como `dsh-tui-agent-workers` 0.1.x.
   6. Después: si el panel empieza a moverse al ritmo de dsh-tui más que al de agent-workers, extraerlo con `git subtree split` a `dsh-tui-plugins` (C), pasando a consumir el protocolo publicado.
