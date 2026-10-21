import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { JobAdminError } from '../admin.js';
import { JobError } from '../errors.js';
import {
  CONTROL_LIMITS,
  ControlError,
  httpStatusFor,
  INCLUDE_OPTIONS,
  JOB_ID_PATTERN,
} from './protocol.js';
import type { ControlService } from './service.js';

export interface StartControlServerOptions {
  service: ControlService;
  token: string;
}

export interface ControlServer {
  base_url: string;
  port: number;
  close(): Promise<void>;
}

type Route =
  | { kind: 'health' }
  | { kind: 'jobs' }
  | { kind: 'job'; jobId: string }
  | { kind: 'events'; jobId: string }
  | { kind: 'result'; jobId: string }
  | { kind: 'cancel'; jobId: string }
  | { kind: 'steer'; jobId: string }
  | { kind: 'cleanup'; jobId: string }
  | { kind: 'delete'; jobId: string };

function tokenMatches(header: string | undefined, token: string): boolean {
  const prefix = 'Bearer ';
  if (header === undefined || !header.startsWith(prefix)) return false;
  const presented = Buffer.from(header.slice(prefix.length), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): void {
  sendJson(res, status, { error: code, message, ...details });
}

function sendFailure(res: ServerResponse, err: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  const code =
    err instanceof ControlError || err instanceof JobError || err instanceof JobAdminError
      ? err.code
      : 'internal_error';
  const message = err instanceof Error ? err.message : 'internal error';
  const details = err instanceof ControlError || err instanceof JobAdminError ? err.details : {};
  sendError(res, httpStatusFor(code), code, message, details);
}

function hasBody(req: IncomingMessage): boolean {
  const raw = req.headers['content-length'];
  if (raw !== undefined) {
    const length = Number(raw);
    if (!Number.isInteger(length) || length < 0) {
      throw new ControlError('invalid_request', 'invalid content-length');
    }
    return length > 0;
  }
  return req.headers['transfer-encoding'] !== undefined;
}

function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false;
  return value.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (!hasBody(req)) return undefined;
  if (!isJsonContentType(req.headers['content-type'])) {
    throw new ControlError(
      'unsupported_media_type',
      'requests with a body must use Content-Type: application/json',
    );
  }
  const rawLength = req.headers['content-length'];
  if (rawLength !== undefined && Number(rawLength) > CONTROL_LIMITS.maxBodyBytes) {
    req.resume();
    throw new ControlError(
      'body_too_large',
      `request body exceeds ${CONTROL_LIMITS.maxBodyBytes} bytes`,
    );
  }

  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > CONTROL_LIMITS.maxBodyBytes) {
        cleanup();
        req.resume();
        reject(
          new ControlError(
            'body_too_large',
            `request body exceeds ${CONTROL_LIMITS.maxBodyBytes} bytes`,
          ),
        );
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
  });

  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new ControlError('invalid_request', 'request body must be valid JSON');
  }
}

function objectBody(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ControlError('invalid_request', 'request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function queryInt(
  url: URL,
  name: string,
  fallback: number,
  min: number,
  max: number,
  code: string,
): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new ControlError(code, `${name} must be an integer from ${min} to ${max}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ControlError(code, `${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function parseInclude(url: URL): string[] {
  const raw = url.searchParams.get('include');
  if (raw === null) return ['final', 'diff_stat'];
  const allowed = new Set<string>(INCLUDE_OPTIONS);
  const include: string[] = [];
  for (const value of raw.split(',').map((entry) => entry.trim())) {
    if (!allowed.has(value)) {
      throw new ControlError(
        'invalid_include',
        `include must be a comma-separated subset of ${INCLUDE_OPTIONS.join(', ')}`,
      );
    }
    if (!include.includes(value)) include.push(value);
  }
  return include;
}

function parseDiscardQuery(url: URL): boolean {
  const raw = url.searchParams.get('discard_changes');
  if (raw === null) return false;
  if (raw === '1' || raw.toLowerCase() === 'true') return true;
  if (raw === '0' || raw.toLowerCase() === 'false') return false;
  throw new ControlError('invalid_request', 'discard_changes must be 1 or 0');
}

function resolveRoute(method: string, pathname: string): Route | undefined {
  if (method === 'GET' && pathname === '/v1/health') return { kind: 'health' };
  if (method === 'GET' && pathname === '/v1/jobs') return { kind: 'jobs' };

  const parts = pathname.split('/');
  if (parts.length < 4 || parts[1] !== 'v1' || parts[2] !== 'jobs') return undefined;
  const jobId = parts[3] ?? '';

  if (parts.length === 4) {
    if (method === 'GET') return { kind: 'job', jobId };
    if (method === 'DELETE') return { kind: 'delete', jobId };
    return undefined;
  }

  if (parts.length !== 5) return undefined;
  const action = parts[4];
  if (method === 'GET' && action === 'events') return { kind: 'events', jobId };
  if (method === 'GET' && action === 'result') return { kind: 'result', jobId };
  if (method === 'POST' && action === 'cancel') return { kind: 'cancel', jobId };
  if (method === 'POST' && action === 'steer') return { kind: 'steer', jobId };
  if (method === 'POST' && action === 'cleanup') return { kind: 'cleanup', jobId };
  return undefined;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  service: ControlService,
  token: string,
  port: number,
): Promise<void> {
  if (!tokenMatches(req.headers.authorization, token)) {
    sendError(res, 401, 'unauthorized', 'missing or invalid bearer token');
    return;
  }
  const expectedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const host = req.headers.host;
  if (host === undefined || !expectedHosts.includes(host)) {
    sendError(res, 403, 'forbidden_host', 'request host is not allowed');
    return;
  }
  const origin = req.headers.origin;
  if (
    origin !== undefined &&
    origin !== `http://127.0.0.1:${port}` &&
    origin !== `http://localhost:${port}`
  ) {
    sendError(res, 403, 'forbidden_origin', 'request origin is not allowed');
    return;
  }

  let url: URL;
  try {
    url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  } catch {
    throw new ControlError('invalid_request', 'invalid request url');
  }
  const method = (req.method ?? 'GET').toUpperCase();
  const route = resolveRoute(method, url.pathname);
  if (!route) {
    sendError(res, 404, 'not_found', 'unknown route');
    return;
  }
  if ('jobId' in route && !JOB_ID_PATTERN.test(route.jobId)) {
    throw new ControlError('invalid_job_id', 'invalid job id');
  }

  switch (route.kind) {
    case 'health':
      sendJson(res, 200, await service.health());
      return;
    case 'jobs':
      sendJson(res, 200, await service.listJobs());
      return;
    case 'job':
      sendJson(res, 200, { job: await service.getJob(route.jobId) });
      return;
    case 'events': {
      const cursor = queryInt(url, 'cursor', 0, 0, Number.MAX_SAFE_INTEGER, 'invalid_cursor');
      const limit = queryInt(
        url,
        'limit',
        200,
        CONTROL_LIMITS.limitMin,
        CONTROL_LIMITS.limitMax,
        'invalid_request',
      );
      sendJson(res, 200, await service.events(route.jobId, cursor, limit));
      return;
    }
    case 'result': {
      const maxChars = queryInt(
        url,
        'max_chars',
        20_000,
        CONTROL_LIMITS.maxCharsMin,
        CONTROL_LIMITS.maxCharsMax,
        'invalid_request',
      );
      const include = parseInclude(url);
      sendJson(res, 200, await service.result(route.jobId, maxChars, include));
      return;
    }
    case 'cancel': {
      objectBody(await readJsonBody(req));
      sendJson(res, 200, await service.cancel(route.jobId));
      return;
    }
    case 'steer': {
      const body = objectBody(await readJsonBody(req));
      if (
        typeof body.message !== 'string' ||
        body.message.length < CONTROL_LIMITS.messageMin ||
        body.message.length > CONTROL_LIMITS.messageMax
      ) {
        throw new ControlError(
          'invalid_request',
          `message must be ${CONTROL_LIMITS.messageMin}..${CONTROL_LIMITS.messageMax} characters`,
        );
      }
      let timeoutS: number | undefined;
      if (body.timeout_s !== undefined) {
        const value = body.timeout_s;
        if (
          typeof value !== 'number' ||
          !Number.isInteger(value) ||
          value < CONTROL_LIMITS.timeoutMinS ||
          value > CONTROL_LIMITS.timeoutMaxS
        ) {
          throw new ControlError(
            'invalid_request',
            `timeout_s must be an integer from ${CONTROL_LIMITS.timeoutMinS} to ${CONTROL_LIMITS.timeoutMaxS}`,
          );
        }
        timeoutS = value;
      }
      sendJson(res, 200, await service.steer(route.jobId, body.message, timeoutS));
      return;
    }
    case 'cleanup': {
      const body = objectBody(await readJsonBody(req));
      const discard = body.discard_changes;
      if (discard !== undefined && typeof discard !== 'boolean') {
        throw new ControlError('invalid_request', 'discard_changes must be a boolean');
      }
      sendJson(res, 200, await service.cleanup(route.jobId, discard === true));
      return;
    }
    case 'delete': {
      const discard = parseDiscardQuery(url);
      objectBody(await readJsonBody(req));
      sendJson(res, 200, await service.delete(route.jobId, discard));
      return;
    }
  }
}

export async function startControlServer(
  options: StartControlServerOptions,
): Promise<ControlServer> {
  let port = 0;
  const server = createServer((req, res) => {
    const timer = setTimeout(() => {
      sendError(res, 500, 'internal_error', 'request timed out');
    }, CONTROL_LIMITS.requestTimeoutMs);
    timer.unref();
    res.once('close', () => clearTimeout(timer));
    void handleRequest(req, res, options.service, options.token, port).catch((err: unknown) => {
      sendFailure(res, err);
    });
  });
  server.requestTimeout = CONTROL_LIMITS.requestTimeoutMs;
  server.headersTimeout = CONTROL_LIMITS.requestTimeoutMs;

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer(server);
    throw new Error('control server did not bind a TCP port');
  }
  port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    base_url: baseUrl,
    port,
    async close(): Promise<void> {
      await closeServer(server);
    },
  };
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
    // Local clients may keep idle keep-alive sockets; shutdown must not wait.
    server.closeAllConnections();
  });
}
