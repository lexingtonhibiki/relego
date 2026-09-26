import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stdout } from "node:process";
import {
  ResearchBatchRequestSchema,
  type ResearchBatchSnapshot,
  type ResearchTaskSnapshot,
} from "./contracts";
import {
  createResearchConfig,
  getResearchConfigPath,
  loadResearchConfig,
  saveResearchConfig,
  type ResearchConfig,
} from "./config";
import { getConfigDir } from "../config";
import { createOpenCodeExecutor, probeOpenCode } from "./opencode";
import { startResearchService } from "./service";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function numberOption(args: string[], name: string, fallback: number): number {
  const value = option(args, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function noArgs(args: string[]): void {
  if (args.length > 0) throw new Error(`Unknown research arguments: ${args.join(" ")}`);
}

async function api(
  config: ResearchConfig,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${config.controlToken}`);
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(`http://${config.host}:${config.port}${path}`, { ...init, headers });
  const text = await response.text();
  if (!text) {
    if (response.ok) throw new Error("Research service returned an empty response");
    return { status: response.status, body: null };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    if (response.ok) throw new Error("Research service returned non-JSON output");
    body = { error: { code: "invalid_response", message: "Research service returned non-JSON output" } };
  }
  return { status: response.status, body };
}

function print(value: unknown): void {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function setupCommand(args: string[]): Promise<void> {
  const model = option(args, "--model");
  const executable = option(args, "--opencode");
  const workspace = option(args, "--workspace");
  const port = numberOption(args, "--port", 17842);
  const timeout = numberOption(args, "--timeout-ms", 120_000);
  const concurrency = numberOption(args, "--max-concurrency", 2);
  noArgs(args);
  if (port < 1 || port > 65_535) throw new Error("--port must be an integer from 1 to 65535");
  if (!model) throw new Error("research setup requires --model provider/model");
  const requestedExecutable = executable ?? "opencode";
  const discoveredExecutable = Bun.which(requestedExecutable)
    ?? (executable ? resolve(executable) : undefined);
  if (!discoveredExecutable) throw new Error(`OpenCode executable was not found: ${requestedExecutable}`);
  const config = createResearchConfig({
    port,
    workspaceRoot: workspace ?? join(getConfigDir(), "research", "jobs"),
    opencodeCommand: [resolve(discoveredExecutable)],
    defaultModel: model,
    defaultTimeoutMs: timeout,
    maxConcurrency: concurrency,
    heartbeatMs: 15_000,
  });
  const capabilities = probeOpenCode(config.opencodeCommand, config.defaultModel);
  saveResearchConfig(config);
  print({
    status: "configured",
    configPath: getResearchConfigPath(),
    opencodeVersion: capabilities.version,
    defaultModel: config.defaultModel,
    models: capabilities.models,
  });
}

async function doctorCommand(args: string[]): Promise<void> {
  noArgs(args);
  const config = loadResearchConfig();
  const capabilities = probeOpenCode(config.opencodeCommand, config.defaultModel);
  let service: { ok: boolean; status?: number; body?: unknown } = { ok: false };
  try {
    const response = await fetch(`http://${config.host}:${config.port}/healthz`);
    service = { ok: response.ok, status: response.status, body: await response.json() };
  } catch (error) {
    service = { ok: false, body: { error: error instanceof Error ? error.message : String(error) } };
  }
  print({
    status: service.ok ? "ok" : "degraded",
    opencodeVersion: capabilities.version,
    defaultModel: config.defaultModel,
    models: capabilities.models,
    service,
  });
  if (!service.ok) process.exitCode = 1;
}

async function serveCommand(args: string[]): Promise<void> {
  noArgs(args);
  const config = loadResearchConfig();
  const capabilities = probeOpenCode(config.opencodeCommand, config.defaultModel);
  const service = startResearchService(config, {
    executor: createOpenCodeExecutor(capabilities),
    models: new Set(capabilities.models),
  });
  print({ status: "listening", host: config.host, port: service.server.port });
  await new Promise<void>(resolve => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await service.stop();
}

function requestBody(path: string): string {
  return readFileSync(path === "-" ? 0 : path, "utf8");
}

async function submitCommand(args: string[], wait: boolean): Promise<void> {
  const path = args.shift();
  noArgs(args);
  if (!path) throw new Error(`research ${wait ? "run" : "submit"} requires REQUEST.json`);
  const config = loadResearchConfig();
  const request = ResearchBatchRequestSchema.parse(JSON.parse(requestBody(path)));
  const idempotencyKey = randomUUID();
  const result = await api(config, `/v1/research/batches?wait=${wait ? "true" : "false"}`, {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify(request),
  });
  if (result.status !== (wait ? 200 : 202)) {
    throw new Error(`Research service returned ${result.status}: ${JSON.stringify(result.body)}`);
  }
  const snapshot = result.body as ResearchBatchSnapshot;
  print(snapshot);
  if (wait && snapshot.tasks.some(task => task.status !== "succeeded")) process.exitCode = 1;
}

async function statusCommand(args: string[]): Promise<void> {
  const taskId = args.shift();
  noArgs(args);
  if (!taskId) throw new Error("research status requires TASK_ID");
  const result = await api(loadResearchConfig(), `/v1/research/tasks/${encodeURIComponent(taskId)}`);
  if (result.status !== 200) throw new Error(`Research service returned ${result.status}: ${JSON.stringify(result.body)}`);
  print(result.body as ResearchTaskSnapshot);
}

async function cancelCommand(args: string[]): Promise<void> {
  const taskId = args.shift();
  noArgs(args);
  if (!taskId) throw new Error("research cancel requires TASK_ID");
  const result = await api(loadResearchConfig(), `/v1/research/tasks/${encodeURIComponent(taskId)}/cancel`, {
    method: "POST",
  });
  if (result.status !== 200) throw new Error(`Research service returned ${result.status}: ${JSON.stringify(result.body)}`);
  print(result.body as ResearchTaskSnapshot);
}

export async function runResearchCli(args: string[]): Promise<void> {
  const action = args.shift();
  if (action === "setup") await setupCommand(args);
  else if (action === "serve") await serveCommand(args);
  else if (action === "run") await submitCommand(args, true);
  else if (action === "submit") await submitCommand(args, false);
  else if (action === "status") await statusCommand(args);
  else if (action === "cancel") await cancelCommand(args);
  else if (action === "doctor") await doctorCommand(args);
  else throw new Error("Research command must be: setup, serve, run, submit, status, cancel, or doctor");
}
