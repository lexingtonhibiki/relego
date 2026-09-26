import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { atomicWriteFile, expandUserPath, getConfigDir, stripUtf8Bom } from "../config";
import { RESEARCH_MODEL_PATTERN } from "./contracts";

export interface ResearchConfig {
  version: 1;
  host: "127.0.0.1";
  port: number;
  controlToken: string;
  workspaceRoot: string;
  opencodeCommand: [string, ...string[]];
  defaultModel: string;
  defaultTimeoutMs: number;
  maxConcurrency: number;
  heartbeatMs: number;
}

export interface ResearchConfigInput {
  port: number;
  workspaceRoot: string;
  opencodeCommand: [string, ...string[]];
  defaultModel: string;
  defaultTimeoutMs: number;
  maxConcurrency: number;
  heartbeatMs: number;
}

export function getResearchConfigPath(): string {
  return join(getConfigDir(), "research", "config.json");
}

export function createResearchConfig(input: ResearchConfigInput): ResearchConfig {
  return parseResearchConfig({
    version: 1,
    host: "127.0.0.1",
    port: input.port,
    controlToken: randomBytes(32).toString("base64url"),
    workspaceRoot: resolve(expandUserPath(input.workspaceRoot)),
    opencodeCommand: input.opencodeCommand,
    defaultModel: input.defaultModel,
    defaultTimeoutMs: input.defaultTimeoutMs,
    maxConcurrency: input.maxConcurrency,
    heartbeatMs: input.heartbeatMs,
  }, getResearchConfigPath());
}

export function parseResearchConfig(value: unknown, path = getResearchConfigPath()): ResearchConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid research configuration object in ${path}`);
  }
  const config = value as Partial<ResearchConfig>;
  if (config.version !== 1) throw new Error(`Unsupported research configuration version in ${path}`);
  if (config.host !== "127.0.0.1") throw new Error("host must be 127.0.0.1");
  if (!Number.isInteger(config.port) || config.port! < 0 || config.port! > 65_535) {
    throw new Error(`Invalid port in ${path}`);
  }
  if (typeof config.controlToken !== "string" || !/^[A-Za-z0-9_-]{40,}$/.test(config.controlToken)) {
    throw new Error(`Invalid controlToken in ${path}`);
  }
  if (typeof config.workspaceRoot !== "string" || !isAbsolute(expandUserPath(config.workspaceRoot))) {
    throw new Error(`workspaceRoot must be absolute in ${path}`);
  }
  if (!Array.isArray(config.opencodeCommand) || config.opencodeCommand.length === 0
    || config.opencodeCommand.some(part => typeof part !== "string" || !part.trim())
    || !isAbsolute(expandUserPath(config.opencodeCommand[0]!))) {
    throw new Error(`opencodeCommand[0] must be an absolute executable path in ${path}`);
  }
  if (typeof config.defaultModel !== "string" || !RESEARCH_MODEL_PATTERN.test(config.defaultModel.trim())) {
    throw new Error(`Invalid defaultModel in ${path}`);
  }
  if (!Number.isInteger(config.defaultTimeoutMs) || config.defaultTimeoutMs! < 1_000
    || config.defaultTimeoutMs! > 3_600_000) {
    throw new Error(`Invalid defaultTimeoutMs in ${path}`);
  }
  if (!Number.isInteger(config.maxConcurrency) || config.maxConcurrency! < 1 || config.maxConcurrency! > 8) {
    throw new Error(`Invalid maxConcurrency in ${path}`);
  }
  if (!Number.isInteger(config.heartbeatMs) || config.heartbeatMs! < 1_000 || config.heartbeatMs! > 60_000) {
    throw new Error(`Invalid heartbeatMs in ${path}`);
  }
  const allowedKeys = new Set([
    "version",
    "host",
    "port",
    "controlToken",
    "workspaceRoot",
    "opencodeCommand",
    "defaultModel",
    "defaultTimeoutMs",
    "maxConcurrency",
    "heartbeatMs",
  ]);
  for (const key of Object.keys(config)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown research configuration field ${JSON.stringify(key)} in ${path}`);
    }
  }
  const opencodeCommand = config.opencodeCommand as [string, ...string[]];
  return {
    version: 1,
    host: "127.0.0.1",
    port: config.port!,
    controlToken: config.controlToken,
    workspaceRoot: resolve(expandUserPath(config.workspaceRoot)),
    opencodeCommand: [resolve(expandUserPath(opencodeCommand[0])), ...opencodeCommand.slice(1)],
    defaultModel: config.defaultModel.trim(),
    defaultTimeoutMs: config.defaultTimeoutMs!,
    maxConcurrency: config.maxConcurrency!,
    heartbeatMs: config.heartbeatMs!,
  };
}

export function loadResearchConfig(): ResearchConfig {
  const path = getResearchConfigPath();
  if (!existsSync(path)) {
    throw new Error(`Research configuration is missing: ${path}. Run codex-chatgpt-web research setup first.`);
  }
  return parseResearchConfig(JSON.parse(stripUtf8Bom(readFileSync(path, "utf8"))), path);
}

export function saveResearchConfig(config: ResearchConfig): void {
  const path = getResearchConfigPath();
  atomicWriteFile(path, `${JSON.stringify(parseResearchConfig(config, path), null, 2)}\n`);
}
