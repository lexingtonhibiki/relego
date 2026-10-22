import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResearchConfig } from "../src/config";
import { ResearchCoordinator } from "../src/coordinator";
import { ResearchStore } from "../src/store";
import { RESEARCH_PROTOCOL_VERSION, ResearchError, type ResearchSubmissionRecord, type ResearchTaskSnapshot } from "../src/contracts";

class TransientQueueReadStore extends ResearchStore {
  failNextRead = false;
  override saveSubmission(record: ResearchSubmissionRecord) {
    super.saveSubmission(record);
    if (record.phase === "committed") this.failNextRead = true;
  }
  override getTask(taskId: string) {
    if (this.failNextRead) {
      this.failNextRead = false;
      throw new ResearchError("resource_error", "one transient task read failure", 500);
    }
    return super.getTask(taskId);
  }
}

test("idempotent retry resumes a task after a transient dispatch read failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "relego-queue-read-"));
  const config = createResearchConfig({ port: 0, workspaceRoot: root, opencodeCommand: [process.execPath], defaultModel: "provider/model", defaultTimeoutMs: 1000, maxConcurrency: 1, heartbeatMs: 1000 });
  const store = new TransientQueueReadStore(root);
  let calls = 0;
  const coordinator = new ResearchCoordinator(config, store, async job => {
    calls++;
    writeFileSync(join(job.workspacePath, "report.md"), "# result\n");
    return { finalText: JSON.stringify({ summary: "ok", feasibility: { verdict: "feasible", notes: "" }, evidence: [], risks: [], unknowns: ["fixture"], reportPath: "report.md" }) };
  }, new Set(["provider/model"]));
  const request = { protocolVersion: RESEARCH_PROTOCOL_VERSION, tasks: [{ description: "offline task" }] };
  try {
    coordinator.start();
    await expect(coordinator.submitBatch(request, "retry-read")).rejects.toMatchObject({ code: "resource_error" });
    const retry = await coordinator.submitBatch(request, "retry-read");
    // This is deterministic: the executor increments before its first suspension.
    expect(calls).toBe(1);
    expect((await coordinator.waitForBatch(retry.batchId)).tasks[0]?.status).toBe("succeeded");
    expect(store.listTasks()).toHaveLength(1);
  } finally {
    await coordinator.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("background dispatch read failure reaches waiters and a retry resumes FIFO without duplicate execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "relego-background-read-"));
  const config = createResearchConfig({ port: 0, workspaceRoot: root, opencodeCommand: [process.execPath], defaultModel: "provider/model", defaultTimeoutMs: 1000, maxConcurrency: 1, heartbeatMs: 1000 });
  let failTask: string | undefined;
  let readFailed!: () => void;
  const failedRead = new Promise<void>(resolve => { readFailed = resolve; });
  class Store extends ResearchStore {
    override getTask(taskId: string) {
      if (taskId === failTask) {
        failTask = undefined;
        readFailed();
        throw new ResearchError("resource_error", "transient background dispatch read", 500);
      }
      return super.getTask(taskId);
    }
  }
  const store = new Store(root);
  let releaseFirst!: () => void;
  const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const calls: string[] = [];
  const coordinator = new ResearchCoordinator(config, store, async job => {
    calls.push(job.taskId);
    if (calls.length === 1) await gate;
    writeFileSync(join(job.workspacePath, "report.md"), "# result\n");
    return { finalText: JSON.stringify({ summary: "ok", feasibility: { verdict: "feasible", notes: "" }, evidence: [], risks: [], unknowns: ["fixture"], reportPath: "report.md" }) };
  }, new Set(["provider/model"]));
  const request = { protocolVersion: RESEARCH_PROTOCOL_VERSION, tasks: [{ description: "first" }, { description: "second" }, { description: "third" }] };
  try {
    coordinator.start();
    const submitted = await coordinator.submitBatch(request, "background-read");
    failTask = submitted.tasks[1]!.taskId;
    releaseFirst();
    await failedRead;
    await expect(coordinator.waitForBatch(submitted.batchId)).rejects.toMatchObject({ code: "resource_error" });
    expect(calls).toEqual([submitted.tasks[0]!.taskId]);
    const retry = await coordinator.submitBatch(request, "background-read");
    expect(retry.batchId).toBe(submitted.batchId);
    const result = await coordinator.waitForBatch(retry.batchId);
    expect(result.tasks.map(task => task.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(calls).toEqual(submitted.tasks.map(task => task.taskId));
    expect(store.listTasks()).toHaveLength(3);
  } finally {
    releaseFirst();
    await coordinator.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("successful queued cancellation clears a dispatch failure but failed persistence does not", async () => {
  const root = mkdtempSync(join(tmpdir(), "relego-cancel-read-"));
  const config = createResearchConfig({ port: 0, workspaceRoot: root, opencodeCommand: [process.execPath], defaultModel: "provider/model", defaultTimeoutMs: 1000, maxConcurrency: 1, heartbeatMs: 1000 });
  class Store extends TransientQueueReadStore {
    failCancellation = true;
    override saveTask(task: ResearchTaskSnapshot) {
      if (this.failCancellation && task.status === "cancelled") throw new ResearchError("resource_error", "cancel write failed", 500);
      super.saveTask(task);
    }
  }
  const store = new Store(root);
  let calls = 0;
  const coordinator = new ResearchCoordinator(config, store, async () => { calls++; throw new Error("must not execute cancelled work"); }, new Set(["provider/model"]));
  const request = { protocolVersion: RESEARCH_PROTOCOL_VERSION, tasks: [{ description: "cancel queued work" }] };
  try {
    coordinator.start();
    await expect(coordinator.submitBatch(request, "cancel-read")).rejects.toMatchObject({ code: "resource_error" });
    const task = store.listTasks()[0]!;
    await expect(coordinator.cancelTask(task.taskId)).rejects.toMatchObject({ message: "cancel write failed" });
    await expect(coordinator.waitForBatch(task.batchId)).rejects.toMatchObject({ message: "one transient task read failure" });
    expect(store.getTask(task.taskId)?.status).toBe("queued");
    store.failCancellation = false;
    expect((await coordinator.cancelTask(task.taskId)).status).toBe("cancelled");
    expect((await coordinator.waitForBatch(task.batchId)).tasks[0]?.status).toBe("cancelled");
    expect((await coordinator.submitBatch(request, "cancel-read")).tasks[0]?.status).toBe("cancelled");
    expect(calls).toBe(0);
  } finally {
    await coordinator.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancelling a failed queue head dispatches the remaining committed tasks", async () => {
  const root = mkdtempSync(join(tmpdir(), "relego-cancel-head-"));
  const config = createResearchConfig({ port: 0, workspaceRoot: root, opencodeCommand: [process.execPath], defaultModel: "provider/model", defaultTimeoutMs: 1000, maxConcurrency: 1, heartbeatMs: 1000 });
  const store = new TransientQueueReadStore(root);
  const calls: string[] = [];
  const coordinator = new ResearchCoordinator(config, store, async job => {
    calls.push(job.taskId);
    writeFileSync(join(job.workspacePath, "report.md"), "# result\n");
    return { finalText: JSON.stringify({ summary: "ok", feasibility: { verdict: "feasible", notes: "" }, evidence: [], risks: [], unknowns: ["fixture"], reportPath: "report.md" }) };
  }, new Set(["provider/model"]));
  const request = { protocolVersion: RESEARCH_PROTOCOL_VERSION, tasks: [{ description: "first" }, { description: "second" }, { description: "third" }] };
  try {
    coordinator.start();
    await expect(coordinator.submitBatch(request, "cancel-head")).rejects.toMatchObject({ code: "resource_error" });
    const submission = store.listSubmissions()[0]!;
    const taskId = submission.batch.taskIds[0]!;
    expect((await coordinator.cancelTask(taskId)).status).toBe("cancelled");
    const result = await coordinator.waitForBatch(submission.batch.batchId);
    expect(result.tasks.map(task => task.status)).toEqual(["cancelled", "succeeded", "succeeded"]);
    expect(calls).toEqual(submission.batch.taskIds.slice(1));
  } finally {
    await coordinator.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("completed idempotent replays are not blocked by an unrelated dispatch read failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "relego-replay-isolation-"));
  const config = createResearchConfig({ port: 0, workspaceRoot: root, opencodeCommand: [process.execPath], defaultModel: "provider/model", defaultTimeoutMs: 1000, maxConcurrency: 1, heartbeatMs: 1000 });
  class Store extends ResearchStore {
    committed = 0;
    failingTaskId = "";
    override saveSubmission(record: ResearchSubmissionRecord) {
      super.saveSubmission(record);
      if (record.phase === "committed" && ++this.committed === 2) this.failingTaskId = record.tasks[0]!.taskId;
    }
    override getTask(taskId: string) {
      if (taskId === this.failingTaskId) throw new ResearchError("resource_error", "persistent unrelated read failure", 500);
      return super.getTask(taskId);
    }
  }
  const store = new Store(root);
  let calls = 0;
  const coordinator = new ResearchCoordinator(config, store, async job => {
    calls++;
    writeFileSync(join(job.workspacePath, "report.md"), "# result\n");
    return { finalText: JSON.stringify({ summary: "ok", feasibility: { verdict: "feasible", notes: "" }, evidence: [], risks: [], unknowns: ["fixture"], reportPath: "report.md" }) };
  }, new Set(["provider/model"]));
  const request = { protocolVersion: RESEARCH_PROTOCOL_VERSION, tasks: [{ description: "replay isolation" }] };
  try {
    coordinator.start();
    const first = await coordinator.submitBatch(request, "completed");
    const result = await coordinator.waitForBatch(first.batchId);
    await expect(coordinator.submitBatch(request, "failing")).rejects.toMatchObject({ code: "resource_error" });
    expect(await coordinator.submitBatch(request, "completed")).toEqual(result);
    await expect(coordinator.submitBatch(request, "failing")).rejects.toMatchObject({ message: "persistent unrelated read failure" });
    expect(calls).toBe(1);
  } finally {
    await coordinator.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
