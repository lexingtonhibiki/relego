import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESEARCH_PROTOCOL_VERSION, type ResearchTaskSnapshot } from "../src/research/contracts";
import { createResearchConfig } from "../src/research/config";
import { ResearchStore } from "../src/research/store";
import { runResearchLiveSmoke } from "../src/research/smoke";

function task(store: ResearchStore, taskId: string, batchId: string): ResearchTaskSnapshot {
  return {
    protocolVersion: RESEARCH_PROTOCOL_VERSION,
    taskId,
    batchId,
    clientKey: "production",
    description: "pre-existing production work",
    effectiveModel: "provider/model-fast",
    timeoutMs: 1_000,
    status: "queued",
    createdAt: "2026-09-24T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    heartbeatAt: null,
    workspacePath: store.workspacePath(taskId),
    report: null,
    artifacts: [],
    error: null,
  };
}

test("live smoke uses an isolated store and leaves pre-existing production work untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccweb-research-smoke-test-"));
  const productionRoot = join(root, "production");
  const productionStore = new ResearchStore(productionRoot);
  const taskId = "rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const batchId = "rb_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  productionStore.saveTask(task(productionStore, taskId, batchId));
  const before = productionStore.listTasks();
  let calls = 0;
  let isolatedWorkspace = "";
  const config = createResearchConfig({
    port: 0,
    workspaceRoot: productionRoot,
    opencodeCommand: [process.execPath],
    defaultModel: "provider/model-fast",
    defaultTimeoutMs: 1_000,
    maxConcurrency: 1,
    heartbeatMs: 1_000,
  });
  try {
    const result = await runResearchLiveSmoke(config, {
      probe: () => ({
        command: [process.execPath],
        version: "fixture",
        help: "--format --model --dir --title --auto",
        models: ["provider/model-fast"],
      }),
      executor: async job => {
        calls += 1;
        isolatedWorkspace = job.workspacePath;
        await Bun.write(join(job.workspacePath, "report.md"), "# smoke\n");
        return {
          finalText: JSON.stringify({
            summary: "smoke",
            feasibility: { verdict: "feasible", notes: "" },
            evidence: [],
            risks: [],
            unknowns: ["fixture"],
            reportPath: "report.md",
          }),
        };
      },
    });
    expect(result.status).toBe("succeeded");
    expect(calls).toBe(1);
    expect(isolatedWorkspace).not.toBe(productionStore.workspacePath(taskId));
    expect(productionStore.listTasks()).toEqual(before);
    expect(productionStore.getTask(taskId)?.status).toBe("queued");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
