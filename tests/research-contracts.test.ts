import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RESEARCH_PROTOCOL_VERSION,
  ResearchBatchRequestSchema,
  ResearchReportSchema,
} from "../src/contracts";
import {
  createResearchConfig,
  getResearchConfigPath,
  loadResearchConfig,
  parseResearchConfig,
  saveResearchConfig,
} from "../src/config";

const validRequest = {
  protocolVersion: RESEARCH_PROTOCOL_VERSION,
  tasks: [{
    clientKey: "pricing-2026-09",
    description: "调查当前定价并给出证据。",
    model: "provider/model-fast",
    timeoutMs: 120_000,
  }],
};

test("research request is strict and rejects duplicate client keys atomically", () => {
  expect(ResearchBatchRequestSchema.parse(validRequest)).toEqual(validRequest);
  expect(() => ResearchBatchRequestSchema.parse({
    ...validRequest,
    tasks: [validRequest.tasks[0], { ...validRequest.tasks[0], description: "另一项" }],
  })).toThrow("clientKey values must be unique within a batch");
  expect(() => ResearchBatchRequestSchema.parse({
    ...validRequest,
    tasks: [{ ...validRequest.tasks[0], workspacePath: "C:\\escape" }],
  })).toThrow();
});

test("report accepts infeasible research but requires a fixed detailed report name", () => {
  const report = {
    summary: "方案不可行。",
    feasibility: { verdict: "infeasible" as const, notes: "缺少企业合同。" },
    evidence: [],
    risks: ["价格可能变化"],
    unknowns: ["企业折扣未知"],
    reportPath: "report.md",
  };
  expect(ResearchReportSchema.parse(report)).toEqual(report);
  expect(() => ResearchReportSchema.parse({ ...report, reportPath: " report.md " })).toThrow();
  expect(() => ResearchReportSchema.parse({ ...report, reportPath: "../report.md" })).toThrow();
});

test("malformed evidence sources return a normal schema rejection", () => {
  const report = {
    summary: "来源无效。",
    feasibility: { verdict: "unknown" as const, notes: "" },
    evidence: [{ claim: "无效来源", source: "not-a-url" }],
    risks: [],
    unknowns: [],
    reportPath: "report.md",
  };
  expect(ResearchReportSchema.safeParse(report).success).toBe(false);
  for (const source of [
    "http://example.com/source",
    "https://example.com/source",
    " https://example.com/source ",
  ]) {
    expect(ResearchReportSchema.safeParse({
      ...report,
      evidence: [{ claim: "有效来源", source }],
    }).success).toBe(true);
  }
});

test("research config rejects unknown top-level fields", () => {
  const config = createResearchConfig({
    port: 0,
    workspaceRoot: tmpdir(),
    opencodeCommand: [process.execPath],
    defaultModel: "provider/model-fast",
    defaultTimeoutMs: 120_000,
    maxConcurrency: 2,
    heartbeatMs: 15_000,
  });
  expect(() => parseResearchConfig({ ...config, unknown: true }, "research-config.json")).toThrow();
});

test("research config is separate, strict, atomic, and round-trips", () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-config-"));
  const previousHome = process.env.RESEARCH_GATEWAY_HOME;
  process.env.RESEARCH_GATEWAY_HOME = root;
  try {
    const config = createResearchConfig({
      port: 0,
      workspaceRoot: join(root, "jobs"),
      opencodeCommand: [process.execPath],
      defaultModel: "provider/model-fast",
      defaultTimeoutMs: 120_000,
      maxConcurrency: 2,
      heartbeatMs: 15_000,
    });
    expect(config).toMatchObject({
      version: 1,
      host: "127.0.0.1",
      maxConcurrency: 2,
      heartbeatMs: 15_000,
    });
    expect(config.controlToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    saveResearchConfig(config);
    expect(loadResearchConfig()).toEqual(config);
    expect(JSON.parse(readFileSync(getResearchConfigPath(), "utf8"))).toEqual(config);
    expect(() => parseResearchConfig({ ...config, host: "0.0.0.0" }, getResearchConfigPath()))
      .toThrow("host must be 127.0.0.1");
  } finally {
    if (previousHome === undefined) delete process.env.RESEARCH_GATEWAY_HOME;
    else process.env.RESEARCH_GATEWAY_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
