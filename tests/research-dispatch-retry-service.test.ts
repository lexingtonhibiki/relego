import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResearchConfig } from "../src/config";
import { RESEARCH_PROTOCOL_VERSION, ResearchError } from "../src/contracts";
import { startResearchService } from "../src/service";
import { ResearchStore } from "../src/store";

test("HTTP idempotent retry executes the committed batch after a dispatch read error", async () => {
  const root = mkdtempSync(join(tmpdir(), "relego-http-retry-"));
  const config = createResearchConfig({ port: 0, workspaceRoot: root, opencodeCommand: [process.execPath], defaultModel: "provider/model", defaultTimeoutMs: 1000, maxConcurrency: 1, heartbeatMs: 1000 });
  let calls = 0;
  const service = startResearchService(config, { models: new Set(["provider/model"]), executor: async job => {
    calls++;
    writeFileSync(join(job.workspacePath, "report.md"), "# result\n");
    return { finalText: JSON.stringify({ summary: "ok", feasibility: { verdict: "feasible", notes: "" }, evidence: [], risks: [], unknowns: ["fixture"], reportPath: "report.md" }) };
  } });
  const original = ResearchStore.prototype.getTask;
  let failNext = true;
  const read = spyOn(ResearchStore.prototype, "getTask").mockImplementation(function(this: ResearchStore, taskId: string) {
    if (this.root === root && failNext) {
      failNext = false;
      throw new ResearchError("resource_error", "transient dispatch read", 500);
    }
    return original.call(this, taskId);
  });
  const endpoint = `http://127.0.0.1:${service.server.port}/v1/research/batches?wait=true`;
  const request = { method: "POST", headers: { authorization: `Bearer ${config.controlToken}`, "content-type": "application/json", "idempotency-key": "http-retry-read" }, body: JSON.stringify({ protocolVersion: RESEARCH_PROTOCOL_VERSION, tasks: [{ description: "offline task" }] }) };
  try {
    const failed = await fetch(endpoint, request);
    expect(failed.status).toBe(500);
    expect((await failed.json() as { error: { code: string } }).error.code).toBe("resource_error");
    const retried = await fetch(endpoint, { ...request, signal: AbortSignal.timeout(500) });
    expect(retried.status).toBe(200);
    const result = await retried.json() as { tasks: { status: string }[] };
    expect(result.tasks.map(task => task.status)).toEqual(["succeeded"]);
    const replay = await fetch(endpoint, request);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(result);
    expect(calls).toBe(1);
    expect(new ResearchStore(root).listTasks()).toHaveLength(1);
  } finally {
    read.mockRestore();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
