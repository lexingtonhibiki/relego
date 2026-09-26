import { timingSafeEqual } from "node:crypto";
import { ZodError } from "zod";
import { VERSION } from "../version";
import {
  ResearchBatchRequestSchema,
  ResearchError,
  type ResearchExecutor,
} from "./contracts";
import type { ResearchConfig } from "./config";
import { ResearchCoordinator } from "./coordinator";
import { ResearchStore } from "./store";

const MAX_RESEARCH_BODY_BYTES = 2 * 1024 * 1024;

export interface ResearchServiceDependencies {
  executor: ResearchExecutor;
  models: ReadonlySet<string>;
}

export interface ResearchService {
  server: ReturnType<typeof Bun.serve>;
  coordinator: ResearchCoordinator;
  stop(): Promise<void>;
}

class InvalidResearchRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidResearchRequestError";
  }
}

function authorized(request: Request, token: string): boolean {
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function redactDescriptions(message: string, descriptions: readonly string[]): string {
  let redacted = message;
  for (const description of descriptions) {
    if (description) redacted = redacted.split(description).join("[redacted]");
  }
  return redacted;
}

function errorResponse(error: unknown, descriptions: readonly string[] = []): Response {
  if (error instanceof ResearchError) {
    return Response.json({
      error: {
        code: error.code,
        message: redactDescriptions(error.message, descriptions),
      },
    }, { status: error.httpStatus });
  }
  if (error instanceof InvalidResearchRequestError) {
    return Response.json({
      error: {
        code: "invalid_request",
        message: error.message,
      },
    }, { status: 400 });
  }
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return Response.json({
      error: {
        code: "invalid_request",
        message: redactDescriptions(
          error instanceof ZodError
            ? error.issues[0]?.message ?? "Research request is invalid"
            : "Research request body is not valid JSON",
          descriptions,
        ),
      },
    }, { status: 400 });
  }
  return Response.json({
    error: {
      code: "resource_error",
      message: redactDescriptions(
        error instanceof Error ? error.message : String(error),
        descriptions,
      ),
    },
  }, { status: 500 });
}

async function readResearchJsonRequestBody(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new InvalidResearchRequestError("Research request body is invalid");
    }
    if (length > MAX_RESEARCH_BODY_BYTES) {
      throw new InvalidResearchRequestError("Research request body exceeds 2MiB");
    }
  }
  const encoding = (request.headers.get("content-encoding") ?? "identity").trim().toLowerCase();
  if (encoding !== "" && encoding !== "identity") {
    throw new InvalidResearchRequestError("Compressed research request bodies are not supported");
  }
  if (!request.body) throw new InvalidResearchRequestError("Research request body is invalid");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_RESEARCH_BODY_BYTES) {
        await reader.cancel();
        throw new InvalidResearchRequestError("Research request body exceeds 2MiB");
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof InvalidResearchRequestError) throw error;
    throw new InvalidResearchRequestError("Research request body is invalid");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new InvalidResearchRequestError("Research request body is not valid JSON");
  }
}

export function startResearchService(
  config: ResearchConfig,
  dependencies: ResearchServiceDependencies,
): ResearchService {
  const store = new ResearchStore(config.workspaceRoot);
  const coordinator = new ResearchCoordinator(
    config,
    store,
    dependencies.executor,
    dependencies.models,
  );
  let stopping: Promise<void> | undefined;
  let server!: ReturnType<typeof Bun.serve>;
  server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/healthz") {
        return Response.json({
          status: "ok",
          service: "codex-chatgpt-web-research",
          version: VERSION,
          pid: process.pid,
          port: server.port,
          models: [...dependencies.models].sort(),
          activeTasks: store.listTasks().filter(task => task.status === "running" || task.status === "cancelling").length,
        });
      }
      if (!url.pathname.startsWith("/v1/research/")) return new Response("Not found", { status: 404 });
      if (!authorized(request, config.controlToken)) return new Response("Unauthorized", { status: 401 });

      let descriptions: string[] = [];
      try {
        if (request.method === "POST" && url.pathname === "/v1/research/batches") {
          const parsed = ResearchBatchRequestSchema.parse(await readResearchJsonRequestBody(request));
          descriptions = parsed.tasks.map(task => task.description);
          const waitValue = url.searchParams.get("wait");
          if (waitValue !== null && waitValue !== "true" && waitValue !== "false") {
            throw new InvalidResearchRequestError("Research wait query must be true or false");
          }
          const wait = waitValue === "true";
          const idempotencyKey = request.headers.get("idempotency-key")?.trim() || undefined;
          const submitted = await coordinator.submitBatch(parsed, idempotencyKey);
          const snapshot = wait ? await coordinator.waitForBatch(submitted.batchId) : submitted;
          return Response.json(snapshot, {
            status: wait ? 200 : 202,
            headers: { "Idempotency-Status": idempotencyKey ? "idempotent" : "non-idempotent" },
          });
        }

        const taskMatch = url.pathname.match(/^\/v1\/research\/tasks\/(rt_[a-f0-9]{32})$/);
        if (request.method === "GET" && taskMatch) {
          return Response.json(coordinator.getTask(taskMatch[1]!));
        }
        const cancelMatch = url.pathname.match(/^\/v1\/research\/tasks\/(rt_[a-f0-9]{32})\/cancel$/);
        if (request.method === "POST" && cancelMatch) {
          return Response.json(await coordinator.cancelTask(cancelMatch[1]!));
        }
        return new Response("Not found", { status: 404 });
      } catch (error) {
        return errorResponse(error, descriptions);
      }
    },
  });

  const stop = async (): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      try {
        await coordinator.stop();
      } finally {
        await server.stop(true);
      }
    })();
    return stopping;
  };
  try {
    coordinator.start();
  } catch (error) {
    server.stop(true);
    throw error;
  }
  return { server, coordinator, stop };
}
