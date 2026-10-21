# Review adversarial: feat/pi-backend (a87c3af..ffa8902)

Worktree: `/home/cesardiaz/projects/dsh-workers-pi`. Commits revisados: 80c01a5 y ffa8902 (fuera: 120aee6).
Contraste con pi 1.3.0 instalado: `pi --help`, `dist/main.js`, `dist/cli/args.js` y `dist/core/agent-session.js`.
Repro propio, sin tocar el repo: `/tmp/claude-1000/-home-cesardiaz-projects-dsh-workers/e37547a2-3f88-438f-b5c0-08a2148ac4c1/scratchpad/pi-review/repro.ts`.

## Resumen
El seam está bien cortado. La parte dsh queda encapsulada en `DshEngine` y no encontré regresiones dsh.
`PiFold` emite exactamente el esquema que ya consumen el pane (`hooks/jobs.ts:408-438`) y el dashboard: mismos `type`, `callId`/`tool`/`input`/`status`, y `usage` con claves `inputTokens`…
Verificación (no modificó el árbol):
- vitest: 65/65
- tsc: 0 errores
- biome: 0 errores (40 infos preexistentes)
- `bundle --check`: al día
- `claude plugin validate`: ✔

Problemas encontrados:
- 1 BLOCKER: resume/steer con pi pierde el contexto sin avisar.
- 4 MAJOR: falso fallo tras auto-retry, task por argv, crash de arranque por perfil, y escritura sin sandbox.
- Varios MINOR y NIT.

## BLOCKER

**B1. Resume/steer con pi arranca una sesión nueva y vacía sin avisar.**
- **Dónde:** `src/jobs.ts:727` pasa `sessionDir: job.dir`, que es el dir del job *nuevo*. `src/engines/pi.ts:124-129` arma `--session-dir <nuevo>/pi-sessions --session-id <id original>`.
- **Qué hace pi:** en `dist/main.js:344-351`, si no encuentra el id en ese dir, avisa por stderr y crea una sesión nueva con ese id.
- **Efecto:** `dsh_steer` sobre un job pi (`jobs.ts:931-971`, que hereda el backend en `jobs.ts:519`) cancela el original y relanza un worker que solo ve la instrucción de steer. Sin error y con status normal.
- **Repro:** el caso 4 devuelve `["/state/jobs/j_new/pi-sessions","orig-session"]`.
- **Agravante:** `supportsResume` (`engines/types.ts:43`, `pi.ts:51`) vale `true` y nunca se lee.
- **Fix mínimo:** rechazar resume y steer para pi con `resume_unavailable` hasta la fase 3, consultando `supportsResume`.
- **Fix real:** `--fork <dir original>/pi-sessions/<sesión>.jsonl` (pi lo soporta, `main.js:290-305`), que conserva el original y la propiedad por job. Otra opción: pasar el dir del job original en el spec.

## MAJOR

**M1. Un auto-retry exitoso de pi termina como `failed/driver_error`.**
- **Dónde:** `pi-fold.ts:174-177` fija `errorMessage` en cada `message_end` con `stopReason:'error'` y nunca lo limpia. pi reintenta errores transitorios (`agent-session.js:801-815`, `agent_end.willRetry:true`).
- **Efecto:** `onClose` evalúa `errorMessage` antes que el final (`jobs.ts`, rama `driver_error`), así que el job falla aunque haya `finalText`.
- **Repro:** el caso 1 da `finalText:"done"`, `turnEndKind:"completed"` y `errorMessage:"pi turn ended with error"`.
- **Fix:** limpiar el error en `agent_end{willRetry:true}` o en `auto_retry_start`, o fijarlo solo al cerrar el run.

**M2. Pasar el task por argv rompe tasks válidos.**
- **Dónde:** `pi.ts:130` hace `args.push(task)` sin `--`.
- **Efecto:** con el parser real de pi (`cli/args.js`, caso 3):
  - `"@src/a.ts explain…"` se convierte en `fileArgs` y el mensaje queda vacío. Ojo: `--` no evita esto.
  - `"--fix the bug"` se traga como flag desconocida.
  - `"- list…"` da error `Unknown option`.
- **Además:**
  - Por encima de `MAX_ARG_STRLEN` (128 KiB) el spawn falla con E2BIG. El límite es `max(100_000)` caracteres (`server.ts:71`); con UTF-8 multibyte se supera.
  - El task queda visible en `/proc/<pid>/cmdline`.
- **Fix:** pi en modo json lee el stdin entubado como prompt inicial (`main.js:726-733`). Usar `taskInput:'stdin'` como dsh y quitar el positional.

**M3. Con `backend=pi` y un `profile` de dsh configurado, el MCP no arranca.**
- **Dónde:** `jobs.ts:292` toma `DSH_WORKERS_PROFILE` y, como está definido, `init` se salta el fallback. Luego `jobs.ts:313` lanza `unknown_profile`.
- **Repro:** caso 5 (`unknown pi profile work-openrouter`).
- **Contexto:** `user_config.profile` es único y compartido (`.mcp.json`). Quien cambie de backend con un perfil puesto se queda sin servidor.
- **Fix:** perfiles por backend (`dsh_profile`/`pi_profile`), o caer al default del engine con un warning en vez de lanzar.

**M4. `workspace-write` con pi es bash sin sandbox.**
- **Dónde:** `pi.ts:127` da `read,bash,edit,write` y pi no tiene permission mode. dsh sí lo aplica con `DSH_PERMISSION_MODE` (`dsh.ts:132`).
- **Efecto:** el worktree aísla git, pero no el filesystem. La postura de seguridad baja respecto a dsh sin opt-in ni aviso.
- **Fix:** limitar pi a read-only en 0.4, o pedir un opt-in explícito y documentarlo. El modo read-only (`read,grep,find,ls` con `--no-mcp --no-extensions`) sí es real.

## MINOR

- **m1. Se pierde el error real de pi.** `pi-fold.ts:175` usa el texto del mensaje, pero pi pone la causa en `message.errorMessage` (`print-mode.js`, `agent-session.js:1526`). El caso 1 pierde `"429 rate limited"` y siempre muestra `"pi turn ended with error"`.
- **m2. Ids con sufijo se toman como nivel de thinking.** `parseModel` (`pi.ts:25-28`) toma cualquier `:[a-z]+` final; `openrouter/qwen/qwen3-coder:free` se convierte en `--thinking free` (caso 2). Hay que validar contra `off|minimal|low|medium|high|xhigh|max`, o pasar el patrón tal cual a `--model`, que ya acepta `:<thinking>`. Lo mismo para `pi_thinking` y `thinking` del JSON de perfiles, que no se validan (`config.ts`, `pi.ts:163`).
- **m3. Mensajes de error con dsh hardcodeado.** `jobs.ts:842` dice `dsh exited …` también en jobs pi; quedan `dsh_unavailable` y `dsh_version` en status. Es una fuga menor del seam.
- **m4. `stopReason:'length'` se reporta mal.** En modo json pi siempre sale con código 0 (`print-mode.js` solo pone `exitCode` en modo text). Un run truncado acaba como `no_final` "no final event" en vez de `turn_error`/length (`pi-fold.ts:227`).
- **m5. Coste 0 tapa la estimación.** `costOf` (`jobs.ts:160`) usa `??`, y pi reporta `cost.total:0` para modelos sin precio, así que nunca cae a `estimateCostUsd` y el watchdog de budget no salta. Si solo algunos turnos traen coste, el total queda parcial.
- **m6. Perfil de fallback cruzado ignora la config.** En `jobs.ts:575`, un job dsh en un servidor pi usa `work-openrouter` a secas, sin el fallback `headless` ni el perfil configurado.
- **m7. Errores silenciosos del archivo de perfiles.** Un `pi-profiles.json` inválido se ignora en silencio (`pi.ts:169`) y solo se lee en `init`, así que editarlo exige reiniciar.
- **m8. Backends desconocidos van a pi.** `engines/index.ts:16`: cualquier valor distinto de `'dsh'` (job.json editado o un backend futuro) cae a pi. Y `saved.backend` no se valida (`jobs.ts:226`).
- **m9. pi no recibe credenciales.** `baseEnv` solo pasa `envAllow`, que no incluye `OPENROUTER_API_KEY` y similares, y las credenciales dsh no se le pasan. pi depende de `auth.json` en `PI_CODING_AGENT_DIR`. Está bien por seguridad, pero no está documentado y falla en el primer prompt, porque `ensureReady` es no-op (`pi.ts:100`) aunque `init` haya visto `version:'unavailable'`.

## NIT

- **Código muerto:** `JobManager.ensureReady` (`jobs.ts:697`) ya no se usa y además apuntaría al engine activo, no al del job.
- **Coste legacy mezclado:** `fromPersisted` copia `saved.costUsd`, que en jobs dsh legacy era la estimación, a `fold.state.costUsd`, que se documenta como "exacto" (`jobs.ts:222`).
- **Init de ambos engines:** `init` arranca los dos (`jobs.ts:304`), es decir `dsh --version`, lectura de credenciales dsh y `pi --version`, aunque solo uno esté activo.
- **Rutas fijas en tests:** `engines.spec.ts:16,34` usa rutas fijas en `/tmp`; si existe `/tmp/agent-workers-fixture-pi-profiles.json`, el test cambia de resultado.

## Tests
- **Calidad:** razonable para el camino feliz. Las regresiones dsh siguen verdes; los 56 previos pasan dentro de los 65.
- **Realismo:**
  - Las fixtures pi están escritas a mano, no capturadas de pi 1.3.0 (por ejemplo, `usage` a nivel raíz en `message_update`).
  - El fake pi (`pi-jobs.spec.ts:9-18`) ignora argv, así que no detectaría flags inválidas ni M2.
  - Una aserción con `arrayContaining` no prueba que falte `--`.
- **Huecos:** cada caso falta como test.
  - resume/steer pi (B1)
  - auto-retry (M1)
  - tasks con `@`, `-` o grandes (M2)
  - `DSH_WORKERS_PROFILE` con backend pi (M3)
  - cancelación de un job pi
  - carga de job.json legacy sin `backend`/`schemaVersion`
  - jobs mixtos dsh/pi en el mismo servidor
  - `stopReason` `length`/`aborted` vía JobManager
  - `errorMessage` de pi
- **Sugerencia:** capturar 3 o 4 trazas reales (`pi --mode json` con modelo barato, un error, un retry y un abort) como golden, y hacer que el fake valide argv con el `parseArgs` de pi.

## Lo que está bien
- El contrato `Engine` es chico y suficiente. `taskInput` explícito, `createFold` por engine y `fromPersisted(saved, engine)`.
- Retrocompatibilidad: `backend ?? 'dsh'` y `schemaVersion` opcional al leer.
- Coalescing correcto: se ignoran `text_delta`, `tool_execution_update` y `message_update`; solo se emite `text_end`.
- No hay doble conteo de usage: se suma solo en `turn_end`, no en `message_end`/`message_update`.
- Líneas malformadas: se cuentan, sin throw, con límite de 16 MiB y decodificación UTF-8 entre chunks.
- Read-only en pi realmente aislado: `--tools read,grep,find,ls --no-mcp --no-extensions --no-skills --no-approve`.
- pi bloquea `auth.json` al refrescar OAuth (`auth-storage.js` usa lock), así que la concurrencia de workers no lo corrompe.
- Config: valores vacíos caen a defaults, `enumEnv` valida `backend` y manifests y `.mcp.json` son coherentes.

## Veredicto
**No mergear tal cual. Mergear con fixes:**
1. B1: al menos bloquear resume/steer para pi usando `supportsResume`.
2. M1, M2 y M3: son de pocas líneas cada uno y tienen repro.
3. M4: decidir, aunque sea con un opt-in.

Los MINOR pueden ir en un seguimiento antes del rename 0.4.
