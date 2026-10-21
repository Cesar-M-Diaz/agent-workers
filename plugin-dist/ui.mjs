#!/usr/bin/env node

// src/ui.ts
import { spawn as spawn2 } from "node:child_process";
import { readFile as readFile7 } from "node:fs/promises";
import { createServer } from "node:http";
import { join as join6, resolve as resolve4 } from "node:path";
import { fileURLToPath } from "node:url";

// src/admin.ts
import { readdir as readdir2, readFile as readFile3, rm as rm3 } from "node:fs/promises";
import { join as join3 } from "node:path";

// src/control/descriptor.ts
import { chmod, lstat, mkdir, readdir, readFile as readFile2, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// src/proc.ts
import {
  execFile,
  spawn
} from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
async function runCapture(command, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs ?? 3e4,
      maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
      encoding: "utf8"
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err;
    return {
      code: typeof e.code === "number" ? e.code : null,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message
    };
  }
}
async function readStartTime(pid) {
  if (process.platform !== "linux") return void 0;
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = text.lastIndexOf(")");
    if (close < 0) return void 0;
    const fields = text.slice(close + 2).trim().split(/\s+/);
    return fields[19];
  } catch {
    return void 0;
  }
}

// src/control/descriptor.ts
var CONTROL_PROTOCOL = "agent-workers-control/1";
var DESCRIPTOR_FILE = /^[A-Za-z0-9_-]+\.json$/;
function controlDir(stateDir) {
  return join(stateDir, "control");
}
function isDescriptor(value, fileOwnerId) {
  if (typeof value !== "object" || value === null) return false;
  const descriptor = value;
  return descriptor.protocol === CONTROL_PROTOCOL && descriptor.owner_id === fileOwnerId && typeof descriptor.pid === "number" && Number.isInteger(descriptor.pid) && descriptor.pid > 0;
}
async function readDescriptors(stateDir) {
  const dir = controlDir(stateDir);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const descriptors = [];
  for (const entry2 of entries) {
    if (!DESCRIPTOR_FILE.test(entry2.name)) continue;
    const path = join(dir, entry2.name);
    try {
      const info = await lstat(path);
      if (!info.isFile()) continue;
      if ((info.mode & 63) !== 0) continue;
      const parsed = JSON.parse(await readFile2(path, "utf8"));
      const fileOwnerId = entry2.name.slice(0, -".json".length);
      if (!isDescriptor(parsed, fileOwnerId)) continue;
      descriptors.push(parsed);
    } catch {
    }
  }
  return descriptors.sort((a, b) => a.owner_id.localeCompare(b.owner_id));
}
async function isOwnerLive(descriptor) {
  if (!Number.isInteger(descriptor.pid) || descriptor.pid <= 0) return false;
  try {
    process.kill(descriptor.pid, 0);
  } catch (err) {
    if (err.code !== "EPERM") return false;
  }
  if (descriptor.pid_start === void 0) return true;
  const current = await readStartTime(descriptor.pid);
  if (current === void 0) return true;
  return current === descriptor.pid_start;
}
async function liveOwnerIds(stateDir, selfOwnerId) {
  const live = /* @__PURE__ */ new Set();
  for (const descriptor of await readDescriptors(stateDir)) {
    if (descriptor.owner_id === selfOwnerId) continue;
    if (await isOwnerLive(descriptor)) live.add(descriptor.owner_id);
  }
  return live;
}

// src/worktree.ts
import { mkdir as mkdir2, rm as rm2, stat } from "node:fs/promises";
import { isAbsolute, join as join2, relative, resolve } from "node:path";
var MAX_DIFF_BYTES = 200 * 1024;
function gitError(action, result) {
  return new Error(
    `${action}: ${result.stderr.trim() || `git exited ${result.code ?? "unknown"}`}`
  );
}
function assertInsideWorktreeRoot(path, worktreeRoot) {
  const rel = relative(resolve(worktreeRoot), resolve(path));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`refusing to remove worktree outside ${worktreeRoot}: ${path}`);
  }
}
async function worktreeHasChanges(info) {
  const status = await runCapture("git", [
    "-C",
    info.path,
    "status",
    "--porcelain",
    "--untracked-files=all"
  ]);
  if (status.code !== 0) return true;
  if (status.stdout.trim() !== "") return true;
  const ahead = await runCapture("git", [
    "-C",
    info.path,
    "rev-list",
    "--count",
    `${info.baseCommit}..HEAD`
  ]);
  if (ahead.code !== 0) return true;
  const count = Number(ahead.stdout.trim());
  return !Number.isInteger(count) || count > 0;
}
function isBrokenWorktreeMetadata(stderr) {
  return /is not a \.git file|cannot remove working tree|validation failed/i.test(stderr);
}
async function cleanupWorktree(info, discardChanges, worktreeRoot) {
  assertInsideWorktreeRoot(info.path, worktreeRoot);
  try {
    const infoStat = await stat(info.path);
    if (!infoStat.isDirectory()) return { worktree: "none", branchDeleted: false };
  } catch (err) {
    if (err.code === "ENOENT")
      return { worktree: "none", branchDeleted: false };
    throw err;
  }
  if (!discardChanges && await worktreeHasChanges(info)) {
    return { worktree: "preserved_dirty", branchDeleted: false };
  }
  const remove = await runCapture("git", [
    "-C",
    info.repoRoot,
    "worktree",
    "remove",
    ...discardChanges ? ["--force"] : [],
    info.path
  ]);
  if (remove.code !== 0) {
    if (!isBrokenWorktreeMetadata(remove.stderr))
      throw gitError("cannot remove git worktree", remove);
    await rm2(info.path, { recursive: true, force: true });
    await runCapture("git", ["-C", info.repoRoot, "worktree", "prune", "--expire", "now"]);
  }
  const branch = await runCapture("git", ["-C", info.repoRoot, "branch", "-D", info.branch]);
  return { worktree: "removed", branchDeleted: branch.code === 0 };
}

// src/admin.ts
var ACTIVE_STATUSES = /* @__PURE__ */ new Set(["queued", "starting", "running"]);
function resourcesOf(id, job) {
  return {
    id,
    status: job.status,
    worktreePath: job.worktree?.path,
    sessionId: job.sessionId,
    sessionDir: job.sessionDir
  };
}
function isActiveStatus(status) {
  return typeof status === "string" && ACTIVE_STATUSES.has(status);
}
function busyKinds(target, other) {
  const kinds = [];
  if (target.worktreePath && target.worktreePath === other.worktreePath) {
    kinds.push("worktree_busy");
  }
  const sameSessionDir = target.sessionDir !== void 0 && target.sessionDir === other.sessionDir;
  const sameSessionId = target.sessionId !== void 0 && target.sessionId === other.sessionId;
  if (sameSessionDir || sameSessionId) kinds.push("session_busy");
  return kinds;
}
async function readStoredJobs(stateDir) {
  let entries;
  try {
    entries = await readdir2(join3(stateDir, "jobs"), { withFileTypes: true });
  } catch {
    return [];
  }
  const jobs = [];
  for (const entry2 of entries) {
    if (!entry2.isDirectory() || !/^[A-Za-z0-9_-]+$/.test(entry2.name)) continue;
    try {
      const job = JSON.parse(
        await readFile3(join3(stateDir, "jobs", entry2.name, "job.json"), "utf8")
      );
      if (typeof job !== "object" || job === null) continue;
      jobs.push({ id: entry2.name, job });
    } catch {
    }
  }
  return jobs;
}
var JobAdminError = class extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
    this.name = "JobAdminError";
  }
  code;
  status;
  details;
};
function jobDir(stateDir, jobId) {
  if (!/^[A-Za-z0-9_-]+$/.test(jobId)) {
    throw new JobAdminError("invalid_job_id", "invalid job id", 400);
  }
  return join3(stateDir, "jobs", jobId);
}
async function readAdminJob(stateDir, jobId) {
  try {
    return JSON.parse(
      await readFile3(join3(jobDir(stateDir, jobId), "job.json"), "utf8")
    );
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new JobAdminError("job_not_found", `unknown job ${jobId}`, 404);
    }
    throw new JobAdminError("job_unreadable", `cannot read job ${jobId}`, 500);
  }
}
function restoreWorktree(saved) {
  const value = saved.worktree;
  if (!value || typeof value.path !== "string" || typeof value.branch !== "string" || typeof value.baseCommit !== "string" || typeof value.repoRoot !== "string") {
    return void 0;
  }
  return {
    path: value.path,
    branch: value.branch,
    baseCommit: value.baseCommit,
    repoRoot: value.repoRoot
  };
}
async function deleteJobRecord(stateDir, jobId, options = {}) {
  const worktreeRoot = options.worktreeRoot ?? join3(stateDir, "worktrees");
  const saved = await readAdminJob(stateDir, jobId);
  const status = typeof saved.status === "string" ? saved.status : "unknown";
  if (ACTIVE_STATUSES.has(status)) {
    throw new JobAdminError("job_active", "cannot delete an active job", 409, {
      status
    });
  }
  let worktree = "none";
  let branchDeleted = false;
  const info = restoreWorktree(saved);
  if (info && saved.worktree?.cleaned !== true) {
    let cleaned;
    try {
      cleaned = await cleanupWorktree(info, options.discardChanges === true, worktreeRoot);
    } catch (err) {
      throw new JobAdminError(
        "worktree_error",
        err instanceof Error ? err.message : String(err),
        500
      );
    }
    if (cleaned.worktree === "preserved_dirty") {
      throw new JobAdminError(
        "worktree_dirty",
        "worktree has uncommitted changes or commits not in the base revision; confirm discarding them to delete the job",
        409,
        { worktree: "preserved_dirty" }
      );
    }
    worktree = cleaned.worktree;
    branchDeleted = cleaned.branchDeleted;
  }
  await rm3(jobDir(stateDir, jobId), { recursive: true, force: true });
  return { job_id: jobId, deleted: true, worktree, branch_deleted: branchDeleted };
}
async function pruneExpiredJobs(stateDir, retentionDays, worktreeRoot = join3(stateDir, "worktrees"), selfOwnerId) {
  const result = {
    deleted: [],
    preserved_dirty: [],
    skipped_busy: [],
    errors: []
  };
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return result;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1e3;
  const stored = await readStoredJobs(stateDir);
  const liveOwners = await liveOwnerIds(stateDir, selfOwnerId ?? "");
  const active = stored.filter((entry2) => isActiveStatus(entry2.job.status)).map((entry2) => resourcesOf(entry2.id, entry2.job));
  for (const entry2 of stored) {
    const saved = entry2.job;
    const status = typeof saved.status === "string" ? saved.status : "unknown";
    if (ACTIVE_STATUSES.has(status)) continue;
    const finished = saved.finishedAt === void 0 ? Number.NaN : Date.parse(saved.finishedAt);
    if (!Number.isFinite(finished) || finished > cutoff) continue;
    const candidate = resourcesOf(entry2.id, saved);
    const busy = active.some(
      (other) => other.id !== candidate.id && busyKinds(candidate, other).length > 0
    );
    if (busy) {
      result.skipped_busy.push(entry2.id);
      continue;
    }
    if (typeof saved.ownerId === "string" && liveOwners.has(saved.ownerId)) continue;
    try {
      await deleteJobRecord(stateDir, entry2.id, { discardChanges: false, worktreeRoot });
      result.deleted.push(entry2.id);
    } catch (err) {
      if (err instanceof JobAdminError && err.code === "worktree_dirty") {
        result.preserved_dirty.push(entry2.id);
      } else {
        result.errors.push({
          job_id: entry2.id,
          message: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }
  return result;
}

// src/config.ts
import { chmod as chmod2, mkdir as mkdir3, readFile as readFile4, stat as stat3 } from "node:fs/promises";
import { homedir as homedir2, tmpdir } from "node:os";
import { join as join4, resolve as resolve3 } from "node:path";

// src/paths.ts
import { realpath, stat as stat2 } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute as isAbsolute2, relative as relative2, resolve as resolve2, sep } from "node:path";
function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return resolve2(homedir(), path.slice(2));
  return path;
}
async function resolveAllowedRoots(values) {
  const roots = [];
  for (const value of values) {
    const expanded = resolve2(expandHome(value));
    let real;
    try {
      const info = await stat2(expanded);
      if (!info.isDirectory()) throw new Error("not a directory");
      real = await realpath(expanded);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`allowed root is not a readable directory: ${value}: ${message}`);
    }
    if (!roots.includes(real)) roots.push(real);
  }
  if (roots.length === 0) throw new Error("at least one allowed root is required");
  return roots;
}

// src/config.ts
function readEnv(name) {
  const suffix = name.startsWith("AGENT_WORKERS_") ? name.slice("AGENT_WORKERS_".length) : name.startsWith("DSH_WORKERS_") ? name.slice("DSH_WORKERS_".length) : void 0;
  if (suffix !== void 0) {
    const current = process.env[`AGENT_WORKERS_${suffix}`];
    if (current !== void 0 && current.trim() !== "") return current;
    return process.env[`DSH_WORKERS_${suffix}`];
  }
  return process.env[name];
}
function intEnv(name, fallback, min, max) {
  const raw = readEnv(name);
  if (raw === void 0 || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}
function optionalIntEnv(name, min, max) {
  const raw = readEnv(name);
  if (raw === void 0 || raw.trim() === "") return void 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}
function floatEnv(name, min, max) {
  const raw = readEnv(name);
  if (raw === void 0 || raw.trim() === "") return void 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number from ${min} to ${max}`);
  }
  return value;
}
function enumEnv(name, fallback, values) {
  const raw = readEnv(name);
  if (raw === void 0 || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (!values.includes(value)) {
    throw new Error(`${name} must be one of: ${values.join(", ")}`);
  }
  return value;
}
function boolEnv(name, fallback = false) {
  const raw = readEnv(name);
  if (raw === void 0 || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}
function isReadOnlyError(err) {
  const code = err.code;
  return code === "EROFS" || code === "EACCES" || code === "EPERM";
}
async function ensurePrivateDir(path, fallbackName) {
  const dir = resolve3(expandHome(path));
  try {
    await mkdir3(dir, { recursive: true, mode: 448 });
    const info = await stat3(dir);
    if (!info.isDirectory()) throw new Error("not a directory");
    await chmod2(dir, 448);
    return dir;
  } catch (err) {
    if (!isReadOnlyError(err)) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`state directory is not usable: ${dir}: ${message}`);
    }
    const fallback = join4(tmpdir(), "agent-workers", fallbackName);
    await mkdir3(fallback, { recursive: true, mode: 448 });
    await chmod2(fallback, 448);
    process.stderr.write(
      `${JSON.stringify({
        event: "state_dir_fallback",
        requested: dir,
        used: fallback,
        reason: err.code
      })}
`
    );
    return fallback;
  }
}
async function defaultStateDir() {
  const base = process.env.XDG_STATE_HOME?.trim() ? process.env.XDG_STATE_HOME.trim() : join4(homedir2(), ".local", "state");
  const legacy = join4(base, "dsh-workers");
  try {
    const info = await stat3(legacy);
    if (info.isDirectory()) return legacy;
  } catch {
  }
  return join4(base, "agent-workers");
}
function splitList(raw) {
  if (!raw) return [];
  return raw.split(/[:,]/).map((value) => value.trim()).filter(Boolean);
}
function pathEnv(name) {
  const raw = readEnv(name)?.trim();
  return raw ? raw : void 0;
}
async function resolveWorkerStateDir() {
  return ensurePrivateDir(pathEnv("AGENT_WORKERS_STATE_DIR") ?? await defaultStateDir(), "state");
}
async function loadConfig() {
  const stateDir = await resolveWorkerStateDir();
  const worktreeRoot = await ensurePrivateDir(
    pathEnv("AGENT_WORKERS_WORKTREE_ROOT") ?? join4(stateDir, "worktrees"),
    "worktrees"
  );
  const dshHome = await ensurePrivateDir(
    pathEnv("AGENT_WORKERS_DSH_HOME") ?? join4(stateDir, "dsh-home"),
    "dsh-home"
  );
  const rootValues = splitList(readEnv("AGENT_WORKERS_ALLOWED_ROOTS"));
  if (rootValues.length === 0) rootValues.push(process.cwd());
  const allowedRoots = await resolveAllowedRoots(rootValues);
  const envAllow = [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TERM",
    "TMPDIR",
    "TZ",
    "NO_COLOR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
    "DEEPSEEK_BASE_URL",
    ...splitList(readEnv("AGENT_WORKERS_ENV_ALLOW"))
  ];
  const piAgentDir = pathEnv("AGENT_WORKERS_PI_AGENT_DIR");
  const piProfilesFile = readEnv("AGENT_WORKERS_PI_PROFILES_FILE")?.trim();
  return {
    backend: enumEnv("AGENT_WORKERS_BACKEND", "dsh", ["dsh", "pi"]),
    dshBin: readEnv("AGENT_WORKERS_DSH_BIN") ? resolve3(expandHome(readEnv("AGENT_WORKERS_DSH_BIN"))) : "dsh",
    piBin: readEnv("AGENT_WORKERS_PI_BIN") ? resolve3(expandHome(readEnv("AGENT_WORKERS_PI_BIN"))) : "pi",
    piDefaultProfile: readEnv("AGENT_WORKERS_PI_PROFILE")?.trim() || "default",
    piProfilesFile: resolve3(expandHome(piProfilesFile || join4(stateDir, "pi-profiles.json"))),
    piModel: readEnv("AGENT_WORKERS_PI_MODEL")?.trim() || "",
    piThinking: readEnv("AGENT_WORKERS_PI_THINKING")?.trim() || "",
    piAgentDir: piAgentDir ? resolve3(expandHome(piAgentDir)) : "",
    piAllowWrite: boolEnv("AGENT_WORKERS_PI_ALLOW_WRITE"),
    allowedRoots,
    stateDir,
    worktreeRoot,
    dshHome,
    control: boolEnv("AGENT_WORKERS_CONTROL", true),
    maxConcurrent: intEnv("AGENT_WORKERS_MAX_CONCURRENT", 3, 1, 8),
    maxQueue: intEnv("AGENT_WORKERS_MAX_QUEUE", 16, 0, 64),
    defaultTimeoutMs: intEnv("AGENT_WORKERS_DEFAULT_TIMEOUT_S", 1200, 60, 3600) * 1e3,
    maxTimeoutMs: intEnv("AGENT_WORKERS_MAX_TIMEOUT_S", 3600, 60, 3600) * 1e3,
    maxDepth: intEnv("AGENT_WORKERS_MAX_DEPTH", 2, 0, 8),
    retentionDays: intEnv("AGENT_WORKERS_RETENTION_DAYS", 7, 0, 3650),
    useDshCredentials: boolEnv("AGENT_WORKERS_USE_DSH_CREDENTIALS"),
    credentialsFile: resolve3(
      expandHome(
        readEnv("AGENT_WORKERS_CREDENTIALS_FILE") ?? join4(homedir2(), ".dsh", ".credentials.yaml")
      )
    ),
    envAllow: [...new Set(envAllow)],
    stallMs: intEnv("AGENT_WORKERS_STALL_S", 120, 30, 3600) * 1e3,
    loopRepeat: intEnv("AGENT_WORKERS_LOOP_REPEAT", 4, 2, 20),
    toolErrorLimit: intEnv("AGENT_WORKERS_TOOL_ERROR_LIMIT", 5, 1, 50),
    maxSteps: optionalIntEnv("AGENT_WORKERS_MAX_STEPS", 1, 1e6),
    maxCostUsd: floatEnv("AGENT_WORKERS_MAX_COST_USD", 0, 1e6),
    watchdogAction: enumEnv("AGENT_WORKERS_WATCHDOG_ACTION", "warn", ["warn", "cancel"])
  };
}

// src/dashboard.ts
import { readdir as readdir3, readFile as readFile5, stat as stat4 } from "node:fs/promises";
import { join as join5 } from "node:path";
var ALERT_KINDS = /* @__PURE__ */ new Set(["stalled", "loop", "tool_errors", "budget"]);
function normalizeAlerts(value) {
  if (!Array.isArray(value)) return [];
  const alerts = [];
  for (const entry2 of value) {
    if (entry2 === null || typeof entry2 !== "object" || Array.isArray(entry2)) continue;
    const alert = entry2;
    if (typeof alert.kind !== "string" || !ALERT_KINDS.has(alert.kind) || typeof alert.message !== "string" || !alert.message.trim() || typeof alert.since !== "string") {
      continue;
    }
    alerts.push({
      kind: alert.kind,
      message: alert.message,
      since: alert.since
    });
  }
  return alerts;
}
function isActive(status) {
  return status === "queued" || status === "starting" || status === "running";
}
function validId(id) {
  return /^[A-Za-z0-9_-]+$/.test(id);
}
async function listDashboardJobs(stateDir) {
  const root = join5(stateDir, "jobs");
  let entries;
  try {
    entries = await readdir3(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const jobs = [];
  for (const entry2 of entries) {
    if (!entry2.isDirectory() || !validId(entry2.name)) continue;
    const dir = join5(root, entry2.name);
    let saved;
    try {
      saved = JSON.parse(await readFile5(join5(dir, "job.json"), "utf8"));
    } catch {
      continue;
    }
    if (typeof saved.id !== "string" || !validId(saved.id)) continue;
    const status = typeof saved.status === "string" ? saved.status : "unknown";
    const createdAt = typeof saved.createdAt === "string" ? saved.createdAt : (/* @__PURE__ */ new Date(0)).toISOString();
    const startedAt = typeof saved.startedAt === "string" ? saved.startedAt : void 0;
    const finishedAt = typeof saved.finishedAt === "string" ? saved.finishedAt : void 0;
    const startMs = Date.parse(startedAt ?? createdAt);
    const endMs = isActive(status) ? Date.now() : Date.parse(finishedAt ?? createdAt);
    let lastEventAt;
    try {
      lastEventAt = (await stat4(join5(dir, "events.ndjson"))).mtime.toISOString();
    } catch {
      lastEventAt = void 0;
    }
    jobs.push({
      id: saved.id,
      label: typeof saved.label === "string" && saved.label.trim() ? saved.label : saved.id,
      group_id: typeof saved.groupId === "string" && saved.groupId.trim() ? saved.groupId : typeof saved.ownerId === "string" && saved.ownerId.trim() ? saved.ownerId : "legacy",
      group_name: typeof saved.groupName === "string" && saved.groupName.trim() ? saved.groupName : "Legacy / ungrouped",
      owner_id: typeof saved.ownerId === "string" ? saved.ownerId : "unknown",
      status,
      ...typeof saved.reason === "string" ? { reason: saved.reason } : {},
      cwd: typeof saved.cwd === "string" ? saved.cwd : "",
      ...typeof saved.access === "string" ? { access: saved.access } : {},
      ...typeof saved.isolation === "string" ? { isolation: saved.isolation } : {},
      worktree: saved.worktree && typeof saved.worktree.path === "string" && typeof saved.worktree.branch === "string" && typeof saved.worktree.baseCommit === "string" ? {
        path: saved.worktree.path,
        branch: saved.worktree.branch,
        base_commit: saved.worktree.baseCommit,
        cleaned: saved.worktree.cleaned === true
      } : null,
      ...typeof saved.sessionId === "string" ? { session_id: saved.sessionId } : {},
      ...typeof saved.profile === "string" ? { profile: saved.profile } : {},
      ...typeof saved.provider === "string" ? { provider: saved.provider } : {},
      ...typeof saved.model === "string" ? { model: saved.model } : {},
      ...typeof saved.costUsd === "number" ? { cost_usd: saved.costUsd } : {},
      created_at: createdAt,
      ...startedAt ? { started_at: startedAt } : {},
      ...finishedAt ? { finished_at: finishedAt } : {},
      elapsed_s: Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, Math.round((Math.max(startMs, endMs) - startMs) / 1e3)) : 0,
      steps: Number.isFinite(saved.steps) ? Math.max(0, saved.steps ?? 0) : 0,
      tool_calls: Number.isFinite(saved.toolCalls) ? Math.max(0, saved.toolCalls ?? 0) : 0,
      ...typeof saved.lastTool === "string" ? { last_tool: saved.lastTool } : {},
      events_count: Number.isFinite(saved.eventsCount) ? Math.max(0, saved.eventsCount ?? 0) : 0,
      malformed_lines: Number.isFinite(saved.malformedLines) ? Math.max(0, saved.malformedLines ?? 0) : 0,
      usage: saved.usage ?? null,
      ...lastEventAt ? { last_event_at: lastEventAt } : {},
      alerts: normalizeAlerts(saved.alerts),
      ...typeof saved.steeredFrom === "string" ? { steered_from: saved.steeredFrom } : {}
    });
  }
  return jobs.sort((a, b) => {
    const activeOrder = Number(isActive(b.status)) - Number(isActive(a.status));
    if (activeOrder !== 0) return activeOrder;
    const groupOrder = a.group_name.localeCompare(b.group_name);
    if (groupOrder !== 0) return groupOrder;
    return b.created_at.localeCompare(a.created_at);
  });
}

// src/events.ts
import { readFile as readFile6 } from "node:fs/promises";
var DEFAULT_LIMIT = 200;
var MAX_LIMIT = 500;
var MAX_RETURNED_EVENT_CHARS = 12e3;
var MAX_PREVIEW_CHARS = 8e3;
function clampLimit(value) {
  if (value === void 0 || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(value)));
}
function parseEvent(line, cursor) {
  const bytes = Buffer.byteLength(line, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return {
      cursor,
      type: "malformed",
      bytes,
      preview: line.slice(0, MAX_PREVIEW_CHARS),
      parse_error: "invalid_json"
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      cursor,
      type: "malformed",
      bytes,
      preview: line.slice(0, MAX_PREVIEW_CHARS),
      parse_error: "not_an_object"
    };
  }
  const event = parsed;
  const type = typeof event.type === "string" ? event.type : "unknown";
  const serialized = JSON.stringify(event);
  if (serialized.length > MAX_RETURNED_EVENT_CHARS) {
    return {
      cursor,
      type,
      bytes,
      truncated: true,
      preview: serialized.slice(0, MAX_PREVIEW_CHARS)
    };
  }
  return { cursor, type, bytes, event };
}
async function readEventPage(eventsPath, cursor = 0, limit) {
  let text;
  try {
    text = await readFile6(eventsPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return { events: [], next_cursor: 0, total_events: 0, has_more: false };
    }
    throw err;
  }
  const lines = text.split("\n").filter((line) => line.length > 0);
  const totalEvents = lines.length;
  const start = Math.max(0, Math.min(totalEvents, Math.trunc(cursor)));
  const count = clampLimit(limit);
  const events = lines.slice(start, start + count).map((line, index) => parseEvent(line, start + index));
  const nextCursor = start + events.length;
  return {
    events,
    next_cursor: nextCursor,
    total_events: totalEvents,
    has_more: nextCursor < totalEvents
  };
}

// src/version.ts
var VERSION = "0.5.0";

// src/ui.ts
var HOST = "127.0.0.1";
var DEFAULT_PORT = 47100;
var DASHBOARD_HTML = new URL("./dashboard.html", import.meta.url);
function parsePort(raw) {
  const value = raw === void 0 || raw.trim() === "" ? DEFAULT_PORT : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`invalid port: ${raw ?? ""}`);
  }
  return value;
}
function parseArgs(args) {
  const options = {
    port: parsePort(process.env.AGENT_WORKERS_UI_PORT ?? process.env.DSH_WORKERS_UI_PORT),
    open: true,
    detach: false,
    serve: false,
    stop: false,
    status: false,
    help: false,
    version: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--port":
        index += 1;
        options.port = parsePort(args[index]);
        break;
      case "--job":
        index += 1;
        if (args[index] === void 0 || args[index] === "")
          throw new Error("--job needs a job id");
        options.job = args[index];
        break;
      case "--no-open":
        options.open = false;
        break;
      case "--open":
        options.open = true;
        break;
      case "--detach":
        options.detach = true;
        break;
      case "--serve":
        options.serve = true;
        break;
      case "--stop":
        options.stop = true;
        break;
      case "--status":
        options.status = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--version":
      case "-V":
        options.version = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}
function helpText() {
  return `agent-workers-ui ${VERSION}

Usage:
  agent-workers-ui [options]

Options:
  --port <n>   Local HTTP port (default: ${DEFAULT_PORT} or AGENT_WORKERS_UI_PORT)
  --job <id>   Open the dashboard focused on one job
  --no-open    Do not open a browser
  --detach     Start a background dashboard and return
  --stop       Stop the dashboard process for this port
  --status     Report whether the dashboard is running
  --serve      Internal: run the server in the foreground
  --help       Show this help
  --version    Show the version

Environment:
  AGENT_WORKERS_STATE_DIR   Worker state directory (legacy DSH_WORKERS_STATE_DIR accepted)
  AGENT_WORKERS_UI_PORT     Default dashboard port (legacy DSH_WORKERS_UI_PORT accepted)
`;
}
function writeJson(res, status, value) {
  const body = `${JSON.stringify(value)}
`;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}
function writeError(res, status, message) {
  writeJson(res, status, { error: message });
}
function isSafeJobId(jobId) {
  return /^[A-Za-z0-9_-]+$/.test(jobId);
}
function parseCursor(raw) {
  if (raw === null || raw.trim() === "") return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`invalid cursor: ${raw}`);
  return value;
}
function delay(ms) {
  return new Promise((done) => setTimeout(done, ms));
}
function sendSse(res, event, data) {
  if (res.destroyed || res.writableEnded) return;
  res.write(`event: ${event}
data: ${JSON.stringify(data)}

`);
}
async function streamDashboard(req, res, stateDir, retentionDays, url) {
  const jobId = url.searchParams.get("job_id");
  if (jobId !== null && !isSafeJobId(jobId)) {
    writeError(res, 400, "invalid job id");
    return;
  }
  let cursor = parseCursor(url.searchParams.get("cursor"));
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write("retry: 1000\n\n");
  let closed = false;
  req.once("close", () => {
    closed = true;
  });
  while (!closed) {
    try {
      const jobs = await listDashboardJobs(stateDir);
      sendSse(res, "jobs", {
        server: {
          name: "agent-workers-ui",
          version: VERSION,
          state_dir: stateDir,
          retention_days: retentionDays
        },
        jobs
      });
      if (jobId !== null) {
        const page = await readEventPage(
          join6(stateDir, "jobs", jobId, "events.ndjson"),
          cursor,
          500
        );
        if (page.total_events < cursor) {
          cursor = 0;
          sendSse(res, "reset", { job_id: jobId });
        } else if (page.events.length > 0) {
          cursor = page.next_cursor;
          sendSse(res, "events", { job_id: jobId, ...page });
        }
      }
    } catch (err) {
      sendSse(res, "stream_error", {
        message: err instanceof Error ? err.message : String(err)
      });
    }
    await delay(750);
  }
  if (!res.writableEnded) res.end();
}
function createDashboardServer(stateDir, options = {}) {
  const retentionDays = options.retentionDays ?? 0;
  const worktreeRoot = options.worktreeRoot ?? join6(stateDir, "worktrees");
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", `http://${HOST}`);
        const deleteMatch = /^\/api\/jobs\/([^/]+)$/.exec(url.pathname);
        if (deleteMatch && req.method === "DELETE") {
          const jobId = decodeURIComponent(deleteMatch[1]);
          if (!isSafeJobId(jobId)) {
            writeError(res, 400, "invalid job id");
            return;
          }
          const discard = ["1", "true", "yes"].includes(
            (url.searchParams.get("discard_changes") ?? "").toLowerCase()
          );
          try {
            writeJson(
              res,
              200,
              await deleteJobRecord(stateDir, jobId, { discardChanges: discard, worktreeRoot })
            );
          } catch (err) {
            if (err instanceof JobAdminError) {
              writeJson(res, err.status, { error: err.code, message: err.message, ...err.details });
            } else {
              throw err;
            }
          }
          return;
        }
        if (req.method !== "GET") {
          writeError(res, 405, "method not allowed");
          return;
        }
        if (url.pathname === "/") {
          const html = await readFile7(DASHBOARD_HTML, "utf8");
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:"
          });
          res.end(html);
          return;
        }
        if (url.pathname === "/api/health") {
          writeJson(res, 200, {
            name: "agent-workers-ui",
            version: VERSION,
            state_dir: stateDir,
            retention_days: retentionDays,
            pid: process.pid
          });
          return;
        }
        if (url.pathname === "/api/jobs") {
          writeJson(res, 200, {
            server: {
              name: "agent-workers-ui",
              version: VERSION,
              state_dir: stateDir,
              retention_days: retentionDays
            },
            jobs: await listDashboardJobs(stateDir)
          });
          return;
        }
        if (url.pathname === "/api/stream") {
          await streamDashboard(req, res, stateDir, retentionDays, url);
          return;
        }
        const match = /^\/api\/jobs\/([^/]+)\/events$/.exec(url.pathname);
        if (match) {
          const jobId = decodeURIComponent(match[1]);
          if (!isSafeJobId(jobId)) {
            writeError(res, 400, "invalid job id");
            return;
          }
          const cursor = parseCursor(url.searchParams.get("cursor"));
          const limitRaw = url.searchParams.get("limit");
          const limit = limitRaw === null ? 500 : Number(limitRaw);
          if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
            writeError(res, 400, "invalid limit");
            return;
          }
          writeJson(res, 200, {
            job_id: jobId,
            ...await readEventPage(join6(stateDir, "jobs", jobId, "events.ndjson"), cursor, limit)
          });
          return;
        }
        writeError(res, 404, "not found");
      } catch (err) {
        if (!res.headersSent) {
          writeError(res, 500, err instanceof Error ? err.message : String(err));
        } else if (!res.writableEnded) {
          res.end();
        }
      }
    })();
  });
  if (retentionDays > 0) {
    let pruning = false;
    const prune = async () => {
      if (pruning) return;
      pruning = true;
      try {
        await pruneExpiredJobs(stateDir, retentionDays, worktreeRoot);
      } finally {
        pruning = false;
      }
    };
    void prune();
    const timer = setInterval(() => void prune(), options.pruneIntervalMs ?? 15 * 60 * 1e3);
    timer.unref();
    server.once("close", () => clearInterval(timer));
  }
  return server;
}
function statusUrl(port, job) {
  const base = `http://${HOST}:${port}/`;
  return job === void 0 ? base : `${base}#${encodeURIComponent(job)}`;
}
async function dashboardHealth(port) {
  try {
    const response = await fetch(`http://${HOST}:${port}/api/health`, {
      signal: AbortSignal.timeout(800)
    });
    if (!response.ok) return void 0;
    const body = await response.json();
    return body.name === "agent-workers-ui" ? body : void 0;
  } catch {
    return void 0;
  }
}
async function probeDashboard(port) {
  return await dashboardHealth(port) !== void 0;
}
async function printDashboardStatus(port) {
  const health = await dashboardHealth(port);
  if (!health) {
    process.stdout.write(`stopped http://${HOST}:${port}/
`);
    return;
  }
  process.stdout.write(
    `running http://${HOST}:${port}/ pid=${health.pid} version=${health.version} retention=${health.retention_days}d
`
  );
}
async function stopDashboard(port) {
  const health = await dashboardHealth(port);
  if (!health) {
    process.stdout.write(`stopped http://${HOST}:${port}/
`);
    return;
  }
  try {
    process.kill(health.pid, "SIGTERM");
  } catch (err) {
    if (err.code !== "ESRCH") throw err;
  }
  const deadline = Date.now() + 5e3;
  while (Date.now() < deadline) {
    if (!await probeDashboard(port)) {
      process.stdout.write(`stopped http://${HOST}:${port}/
`);
      return;
    }
    await delay(100);
  }
  throw new Error(`dashboard pid ${health.pid} did not stop within 5 seconds`);
}
async function waitForDashboard(port, timeoutMs = 5e3) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeDashboard(port)) return true;
    await delay(100);
  }
  return false;
}
function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn2(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => void 0);
  child.unref();
}
async function listen(server, port) {
  await new Promise((done, fail) => {
    const onError = (err) => {
      server.off("listening", onListening);
      fail(err);
    };
    const onListening = () => {
      server.off("error", onError);
      done();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, HOST);
  });
}
async function startForeground(options) {
  const config = await loadConfig();
  const stateDir = config.stateDir;
  const server = createDashboardServer(stateDir, {
    retentionDays: config.retentionDays,
    worktreeRoot: config.worktreeRoot
  });
  await listen(server, options.port);
  const url = statusUrl(options.port, options.job);
  process.stdout.write(`agent-workers ui ${VERSION}
${url}
state: ${stateDir}
`);
  if (options.open) openBrowser(url);
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1e3).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
async function startDetached(options) {
  const url = statusUrl(options.port, options.job);
  const existing = await probeDashboard(options.port);
  if (existing) {
    process.stdout.write(`${url}
`);
    if (options.open) openBrowser(url);
    return;
  }
  const child = spawn2(
    process.execPath,
    [
      fileURLToPath(import.meta.url),
      "--serve",
      "--port",
      String(options.port),
      "--no-open",
      ...options.job === void 0 ? [] : ["--job", options.job]
    ],
    { detached: true, stdio: "ignore", env: process.env }
  );
  child.unref();
  if (!await waitForDashboard(options.port)) {
    throw new Error(`dashboard did not start on port ${options.port}`);
  }
  process.stdout.write(`${url}
`);
  if (options.open) openBrowser(url);
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}
`);
    return;
  }
  if (options.stop && options.status) {
    throw new Error("--stop and --status cannot be combined");
  }
  if (options.status) {
    await printDashboardStatus(options.port);
    return;
  }
  if (options.stop) {
    await stopDashboard(options.port);
    return;
  }
  if (options.detach) {
    await startDetached(options);
  } else {
    await startForeground(options);
  }
}
var entry = process.argv[1];
if (entry !== void 0 && resolve4(entry) === fileURLToPath(import.meta.url)) {
  void main().catch((err) => {
    process.stderr.write(`agent-workers ui: ${err instanceof Error ? err.message : String(err)}
`);
    process.exitCode = 1;
  });
}
export {
  createDashboardServer
};
