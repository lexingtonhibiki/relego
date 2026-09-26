import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RESEARCH_PROTOCOL_VERSION,
  ResearchError,
  type ResearchBatchRequest,
  type ResearchExecutor,
  type ResearchExecutorJob,
  type ResearchExecutorResult,
  type ResearchSubmissionRecord,
  type ResearchTaskSnapshot,
  type ResearchTaskStatus,
} from "../src/contracts";
import { createResearchConfig, type ResearchConfigInput } from "../src/config";
import { ResearchCoordinator, type ResearchCoordinatorOptions } from "../src/coordinator";
import { ResearchStore } from "../src/store";

function request(tasks: Array<{
  clientKey: string;
  description: string;
  model?: string;
  timeoutMs?: number;
}>): ResearchBatchRequest {
  return {
    protocolVersion: RESEARCH_PROTOCOL_VERSION,
    tasks: tasks.map(task => ({
      ...task,
      ...(task.model ? { model: task.model } : {}),
      ...(task.timeoutMs ? { timeoutMs: task.timeoutMs } : {}),
    })),
  };
}

function fixtureRoot(label: string, overrides: Partial<ResearchConfigInput> = {}) {
  const root = mkdtempSync(join(tmpdir(), label));
  const config = createResearchConfig({
    port: 0,
    workspaceRoot: join(root, "jobs"),
    opencodeCommand: [process.execPath],
    defaultModel: "provider/model-fast",
    defaultTimeoutMs: 1_000,
    maxConcurrency: 2,
    heartbeatMs: 1_000,
    ...overrides,
  });
  return { root, config, store: new ResearchStore(config.workspaceRoot) };
}

function storedTask(
  store: ResearchStore,
  taskId: string,
  batchId: string,
  clientKey: string,
  status: ResearchTaskStatus,
): ResearchTaskSnapshot {
  const startedAt = status === "queued" ? null : "2026-09-24T00:00:01.000Z";
  return {
    protocolVersion: RESEARCH_PROTOCOL_VERSION,
    taskId,
    batchId,
    clientKey,
    description: `recover ${clientKey}`,
    effectiveModel: "provider/model-fast",
    timeoutMs: 1_000,
    status,
    createdAt: "2026-09-24T00:00:00.000Z",
    startedAt,
    finishedAt: null,
    heartbeatAt: startedAt,
    workspacePath: store.workspacePath(taskId),
    report: null,
    artifacts: [],
    error: null,
  };
}

function successfulResult() {
  return {
    finalText: JSON.stringify({
      summary: "ok",
      feasibility: { verdict: "feasible", notes: "" },
      evidence: [],
      risks: [],
      unknowns: ["fixture"],
      reportPath: "report.md",
    }),
  };
}

class FailingResearchStore extends ResearchStore {
  constructor(
    root: string,
    private readonly shouldFail: (task: ResearchTaskSnapshot) => boolean,
    private readonly failure: unknown = new ResearchError("resource_error", "resource_error: injected save failure", 500),
  ) {
    super(root);
  }

  override saveTask(task: ResearchTaskSnapshot): void {
    if (this.shouldFail(task)) {
      throw this.failure;
    }
    super.saveTask(task);
  }
}

class FailingSubmissionStore extends ResearchStore {
  private taskSaves = 0;
  private batchSaves = 0;
  private idempotencySaves = 0;

  constructor(
    root: string,
    private readonly failurePoint: "task" | "batch" | "idempotency",
    private readonly taskFailureIndex = 0,
  ) {
    super(root);
  }

  override saveTask(task: ResearchTaskSnapshot): void {
    if (this.failurePoint === "task" && task.status === "queued" && this.taskSaves++ === this.taskFailureIndex) {
      throw new ResearchError("resource_error", "resource_error: injected task submission failure", 500);
    }
    super.saveTask(task);
  }

  override saveBatch(batch: Parameters<ResearchStore["saveBatch"]>[0]): void {
    if (this.failurePoint === "batch" && this.batchSaves++ === 0) {
      throw new ResearchError("resource_error", "resource_error: injected batch submission failure", 500);
    }
    super.saveBatch(batch);
  }

  override saveIdempotency(record: Parameters<ResearchStore["saveIdempotency"]>[0]): void {
    if (this.failurePoint === "idempotency" && this.idempotencySaves++ === 0) {
      throw new ResearchError("resource_error", "resource_error: injected idempotency submission failure", 500);
    }
    super.saveIdempotency(record);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(count = 8): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

interface ScheduledCallback {
  id: number;
  kind: "timeout" | "interval";
  delay: number;
  handler: () => void;
  active: boolean;
}

class ManualScheduler {
  currentTime = Date.parse("2026-09-24T00:00:00.000Z");
  nextHandle = 1;
  readonly timeouts: ScheduledCallback[] = [];
  readonly intervals: ScheduledCallback[] = [];

  readonly options: ResearchCoordinatorOptions = {
    now: () => this.currentTime,
    sleep: async () => {},
    setTimeout: (handler, timeout) => this.schedule("timeout", handler, timeout),
    clearTimeout: handle => this.clear("timeout", handle),
    setInterval: (handler, timeout) => this.schedule("interval", handler, timeout),
    clearInterval: handle => this.clear("interval", handle),
  };

  setTime(time: number | string): void {
    this.currentTime = typeof time === "number" ? time : Date.parse(time);
  }

  activeTimeouts(): ScheduledCallback[] {
    return this.timeouts.filter(entry => entry.active);
  }

  activeIntervals(): ScheduledCallback[] {
    return this.intervals.filter(entry => entry.active);
  }

  fireTimeout(delay: number): void {
    const entry = this.activeTimeouts().find(candidate => candidate.delay === delay);
    if (!entry) throw new Error(`No active timeout with delay ${delay}`);
    entry.handler();
  }

  fireInterval(delay: number): void {
    const entry = this.activeIntervals().find(candidate => candidate.delay === delay);
    if (!entry) throw new Error(`No active interval with delay ${delay}`);
    entry.handler();
  }

  private schedule(kind: ScheduledCallback["kind"], handler: () => void, delay: number): number {
    const entry: ScheduledCallback = { id: this.nextHandle++, kind, delay, handler, active: true };
    if (kind === "timeout") this.timeouts.push(entry);
    else this.intervals.push(entry);
    return entry.id;
  }

  private clear(kind: ScheduledCallback["kind"], handle: number): void {
    const entries = kind === "timeout" ? this.timeouts : this.intervals;
    const entry = entries.find(candidate => candidate.id === handle);
    if (entry) entry.active = false;
  }
}

function manualDeadline() {
  const scheduler = new ManualScheduler();
  return {
    options: scheduler.options,
    scheduler,
    fire: () => {
      for (const entry of scheduler.activeTimeouts()) entry.handler();
    },
  };
}

test("detailed artifact is absent after a terminal-save failure and restart", async () => {
  const { root, config } = fixtureRoot("ccweb-research-artifact-recovery-");
  const terminalAttempt = deferred<void>();
  const store = new FailingResearchStore(config.workspaceRoot, task => {
    if (task.status === "succeeded") {
      terminalAttempt.resolve();
      return true;
    }
    return false;
  });
  const coordinator = new ResearchCoordinator(config, store, async job => {
    await Bun.write(join(job.workspacePath, "report.md"), "# report\n");
    return successfulResult();
  }, new Set(["provider/model-fast"]));
  try {
    const submitted = await coordinator.submitBatch(request([{ clientKey: "artifact", description: "artifact" }]), "idem-artifact-recovery");
    await terminalAttempt.promise;
    await flushMicrotasks();
    const taskId = submitted.tasks[0]!.taskId;
    const artifactPath = join(config.workspaceRoot, "jobs", taskId, "artifacts", "detailed-report.md");
    expect(existsSync(artifactPath)).toBe(false);
    const restarted = new ResearchCoordinator(config, store, async () => successfulResult(), new Set(["provider/model-fast"]));
    restarted.start();
    expect(restarted.getTask(taskId)).toMatchObject({ status: "interrupted" });
    expect(existsSync(artifactPath)).toBe(false);
    await restarted.stop();
  } finally {
    await coordinator.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("submission persistence failure is replayed without duplicate execution", async () => {
  for (const failurePoint of ["task", "batch", "idempotency"] as const) {
    const { root, config } = fixtureRoot(`ccweb-research-submission-${failurePoint}-`);
    const store = new FailingSubmissionStore(config.workspaceRoot, failurePoint);
    let calls = 0;
    const coordinator = new ResearchCoordinator(config, store, async job => {
      calls += 1;
      await Bun.write(join(job.workspacePath, "report.md"), "# report\n");
      return successfulResult();
    }, new Set(["provider/model-fast"]));
    const key = `idem-submission-${failurePoint}`;
    try {
      await expect(coordinator.submitBatch(request([{ clientKey: failurePoint, description: failurePoint }]), key))
        .rejects.toMatchObject({ code: "resource_error" });
      const restarted = new ResearchCoordinator(config, store, async job => {
        calls += 1;
        await Bun.write(join(job.workspacePath, "report.md"), "# report\n");
        return successfulResult();
      }, new Set(["provider/model-fast"]));
      restarted.start();
      const replay = await restarted.submitBatch(request([{ clientKey: failurePoint, description: failurePoint }]), key);
      expect(replay.batchId).toMatch(/^rb_[a-f0-9]{32}$/);
      expect(replay.tasks.every(task => task.status === "interrupted")).toBeTrue();
      expect(calls).toBe(0);
      await restarted.stop();
    } finally {
      await coordinator.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("submission journal recovery fails closed at every task write boundary", async () => {
  for (let failureIndex = 0; failureIndex < 3; failureIndex += 1) {
    const { root, config } = fixtureRoot(`ccweb-research-submission-task-${failureIndex}-`);
    const store = new FailingSubmissionStore(config.workspaceRoot, "task", failureIndex);
    let calls = 0;
    const coordinator = new ResearchCoordinator(config, store, async () => {
      calls += 1;
      return successfulResult();
    }, new Set(["provider/model-fast"]));
    const key = `idem-task-boundary-${failureIndex}`;
    const submittedRequest = request([
      { clientKey: "one", description: "one" },
      { clientKey: "two", description: "two" },
      { clientKey: "three", description: "three" },
    ]);
    try {
      await expect(coordinator.submitBatch(submittedRequest, key)).rejects.toMatchObject({ code: "resource_error" });
      const restarted = new ResearchCoordinator(config, store, async () => {
        calls += 1;
        return successfulResult();
      }, new Set(["provider/model-fast"]));
      restarted.start();
      const replay = await restarted.submitBatch(submittedRequest, key);
      expect(replay.tasks).toHaveLength(3);
      expect(replay.tasks.every(task => task.status === "interrupted")).toBeTrue();
      expect(calls).toBe(0);
      await restarted.stop();
    } finally {
      await coordinator.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("prepared submission journal is terminalized before restart execution", async () => {
  const { root, config, store } = fixtureRoot("ccweb-research-prepared-journal-");
  const taskId = "rt_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const batchId = "rb_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const task = storedTask(store, taskId, batchId, "prepared", "queued");
  const batch = {
    protocolVersion: RESEARCH_PROTOCOL_VERSION,
    batchId,
    idempotencyKey: null,
    requestHash: "f".repeat(64),
    createdAt: task.createdAt,
    taskIds: [taskId],
  };
  const submission: ResearchSubmissionRecord = {
    protocolVersion: RESEARCH_PROTOCOL_VERSION,
    phase: "prepared",
    batch,
    idempotency: null,
    tasks: [task],
    createdAt: task.createdAt,
  };
  let calls = 0;
  const coordinator = new ResearchCoordinator(config, store, async () => {
    calls += 1;
    return successfulResult();
  }, new Set(["provider/model-fast"]));
  try {
    store.saveSubmission(submission);
    coordinator.start();
    expect(calls).toBe(0);
    expect(coordinator.getTask(taskId).status).toBe("interrupted");
    expect(store.getSubmission(batchId)?.phase).toBe("aborted");
    expect(store.getBatch(batchId)?.taskIds).toEqual([taskId]);
  } finally {
    await coordinator.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovered queued tasks are ordered across persisted batches", async () => {
  const { root, config, store } = fixtureRoot("ccweb-research-recovery-order-");
  const olderBatch = "rb_11111111111111111111111111111111";
  const newerBatch = "rb_22222222222222222222222222222222";
  const older = storedTask(store, "rt_11111111111111111111111111111111", olderBatch, "older", "queued");
  const newer = storedTask(store, "rt_22222222222222222222222222222222", newerBatch, "newer", "queued");
  store.saveTask({ ...older, createdAt: "2026-09-24T00:00:00.000Z" });
  store.saveTask({ ...newer, createdAt: "2026-09-24T00:00:01.000Z" });
  store.saveBatch({
    protocolVersion: RESEARCH_PROTOCOL_VERSION,
    batchId: newerBatch,
    idempotencyKey: null,
    requestHash: "b".repeat(64),
    createdAt: newer.createdAt,
    taskIds: [newer.taskId],
  });
  store.saveBatch({
    protocolVersion: RESEARCH_PROTOCOL_VERSION,
    batchId: olderBatch,
    idempotencyKey: null,
    requestHash: "a".repeat(64),
    createdAt: older.createdAt,
    taskIds: [older.taskId],
  });
  const started: string[] = [];
  const coordinator = new ResearchCoordinator(config, store, async job => {
    started.push(job.taskId);
    await Bun.write(join(job.workspacePath, "report.md"), "# report\n");
    return successfulResult();
  }, new Set(["provider/model-fast"]));
  try {
    coordinator.start();
    await coordinator.waitForBatch(newerBatch);
    expect(started).toEqual([older.taskId, newer.taskId]);
  } finally {
    await coordinator.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("batch rejects an unavailable model before creating tasks or calling the executor", async () => {
  const { root, config, store } = fixtureRoot("ccweb-research-model-");
  let calls = 0;
  const coordinator = new ResearchCoordinator(config, store, async job => {
    calls += 1;
    await Bun.write(join(job.workspacePath, "report.md"), "# report\n");
    return successfulResult();
  }, new Set(["provider/model-fast"]));
  try {
    await expect(coordinator.submitBatch(request([
      { clientKey: "one", description: "one" },
      { clientKey: "two", description: "two", model: "provider/missing" },
    ]), "idem-1234567890")).rejects.toThrow("model_unavailable");
    expect(calls).toBe(0);
    expect(store.listTasks()).toEqual([]);
  } finally {
    await coordinator.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("idempotency canonicalizes defaults and property order but rejects a different normalized request", async () => {
  const { root, config, store } = fixtureRoot("ccweb-research-idempotency-");
  let calls = 0;
  const coordinator = new ResearchCoordinator(config, store, async job => {
    calls += 1;
    await Bun.write(join(job.workspacePath, "report.md"), "# report\n");
    return successfulResult();
  }, new Set(["provider/model-fast"]));
  const key = "idem-1234567890-canonical";
  try {
    const original: ResearchBatchRequest = {
      protocolVersion: RESEARCH_PROTOCOL_VERSION,
      tasks: [
        { clientKey: "pricing", description: "normalized request" },
        { clientKey: "coverage", description: "second request" },
      ],
    };
    const equivalent: ResearchBatchRequest = {
      tasks: [
        {
          timeoutMs: config.defaultTimeoutMs,
          model: config.defaultModel,
          description: "normalized request",
          clientKey: "pricing",
        },
        {
          timeoutMs: config.defaultTimeoutMs,
          model: config.defaultModel,
          description: "second request",
          clientKey: "coverage",
        },
      ],
      protocolVersion: RESEARCH_PROTOCOL_VERSION,
    };
    const first = await coordinator.submitBatch(original, key);
    await coordinator.waitForBatch(first.batchId);
    const replay = await coordinator.submitBatch(equivalent, key);

    expect(replay.batchId).toBe(first.batchId);
    expect(replay.tasks.map(task => task.taskId)).toEqual(first.tasks.map(task => task.taskId));
    expect(calls).toBe(2);
    await expect(coordinator.submitBatch(request([
      { clientKey: "pricing", description: "different normalized request" },
      { clientKey: "coverage", description: "second request" },
    ]), key)).rejects.toMatchObject({ code: "idempotency_conflict", httpStatus: 409 });
    await expect(coordinator.submitBatch(request([
      { clientKey: "pricing", description: "normalized request", timeoutMs: 2_000 },
      { clientKey: "coverage", description: "second request" },
    ]), key)).rejects.toMatchObject({ code: "idempotency_conflict", httpStatus: 409 });
    await expect(coordinator.submitBatch(request([
      { clientKey: "coverage", description: "second request" },
      { clientKey: "pricing", description: "normalized request" },
    ]), key)).rejects.toMatchObject({ code: "idempotency_conflict", httpStatus: 409 });
    expect(calls).toBe(2);
  } finally {
    await coordinator.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("FIFO input order is preserved while maxConcurrency limits active executors", async () => {
  const { root, config, store } = fixtureRoot("ccweb-research-fifo-");
  const scheduler = new ManualScheduler();
  const jobs: ResearchExecutorJob[] = [];
  const gates = Array.from({ length: 4 }, () => deferred<ResearchExecutorResult>());
  const thirdStarted = deferred<void>();
  const coordinator = new ResearchCoordinator(config, store, job => {
    const index = jobs.length;
    jobs.push(job);
    if (index === 2) thirdStarted.resolve();
    job.signal.addEventListener("abort", () => gates[index]!.reject(job.signal.reason), { once: true });
    return gates[index]!.promise;
  }, new Set(["provider/model-fast"]), scheduler.options);
  try {
    const submitted = await coordinator.submitBatch(request([
      { clientKey: "one", description: "one" },
      { clientKey: "two", description: "two" },
      { clientKey: "three", description: "three" },
      { clientKey: "four", description: "four" },
    ]), "idem-1234567890-fifo");

    expect(jobs.map(job => job.taskId)).toEqual(submitted.tasks.slice(0, 2).map(task => task.taskId));
    expect(submitted.tasks.map(task => task.status)).toEqual(["running", "running", "queued", "queued"]);

    await Bun.write(join(jobs[0]!.workspacePath, "report.md"), "# one\n");
    gates[0]!.resolve(successfulResult());
    await thirdStarted.promise;
    expect(jobs.map(job => job.taskId)).toEqual(submitted.tasks.slice(0, 3).map(task => task.taskId));

    for (const index of [1, 2, 3]) {
      await Bun.write(join(jobs[index]!.workspacePath, "report.md"), `# ${index + 1}\n`);
      gates[index]!.resolve(successfulResult());
    }
    const settled = await coordinator.waitForBatch(submitted.batchId);
    expect(settled.tasks.map(task => task.taskId)).toEqual(submitted.tasks.map(task => task.taskId));
    expect(settled.tasks.map(task => task.status)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
    expect(jobs.map(job => job.taskId)).toEqual(submitted.tasks.map(task => task.taskId));
    expect(scheduler.activeIntervals()).toEqual([]);
    expect(scheduler.activeTimeouts()).toEqual([]);
  } finally {
    await coordinator.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("executor receives task arguments, effective model, workspace, prompt, callbacks, and configured timers", async () => {
  const { root, config, store } = fixtureRoot("ccweb-research-arguments-", {
    defaultTimeoutMs: 3_210,
    heartbeatMs: 6_543,
  });
  const scheduler = new ManualScheduler();
  const jobs: ResearchExecutorJob[] = [];
  const coordinator = new ResearchCoordinator(config, store, job => {
    jobs.push(job);
    return new Promise((_resolve, reject) => {
      job.signal.addEventListener("abort", () => reject(job.signal.reason), { once: true });
    });
  }, new Set(["provider/model-fast", "provider/model-override"]), scheduler.options);
  try {
    const submitted = await coordinator.submitBatch(request([
      { clientKey: "default", description: "configured defaults" },
      { clientKey: "override", description: "task overrides", model: "provider/model-override", timeoutMs: 9_000 },
    ]), "idem-1234567890-arguments");

    expect(jobs.map(job => job.taskId)).toEqual(submitted.tasks.map(task => task.taskId));
    expect(jobs.map(job => job.model)).toEqual(["provider/model-fast", "provider/model-override"]);
    expect(jobs.map(job => job.workspacePath)).toEqual(submitted.tasks.map(task => task.workspacePath));
    expect(jobs[0]!.prompt).toContain("configured defaults");
    expect(jobs[1]!.prompt).toContain("task overrides");
    expect(jobs.every(job => job.signal instanceof AbortSignal)).toBeTrue();
    expect(jobs.every(job => typeof job.onHeartbeat === "function")).toBeTrue();
    expect(jobs.every(job => typeof job.onPartial === "function")).toBeTrue();
    expect(scheduler.activeIntervals().map(entry => entry.delay)).toEqual([6_543, 6_543]);
    expect(scheduler.activeTimeouts().map(entry => entry.delay)).toEqual([3_210, 9_000]);

    await coordinator.stop();
    expect(scheduler.activeIntervals()).toEqual([]);
    expect(scheduler.activeTimeouts()).toEqual([]);
  } finally {
    await coordinator.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale and equal heartbeats preserve ordering without resetting the absolute deadline", async () => {
  const { root, config, store } = fixtureRoot("ccweb-research-heartbeat-order-", {
    defaultTimeoutMs: 5_000,
    heartbeatMs: 1_234,
  });
  const scheduler = new ManualScheduler();
  let startedJob: ResearchExecutorJob | undefined;
  const coordinator = new ResearchCoordinator(config, store, job => {
    startedJob = job;
    return new Promise((_resolve, reject) => {
      job.signal.addEventListener("abort", () => reject(job.signal.reason), { once: true });
    });
  }, new Set(["provider/model-fast"]), scheduler.options);
  try {
    const submitted = await coordinator.submitBatch(request([
      { clientKey: "heartbeat", description: "heartbeat ordering" },
    ]), "idem-1234567890-heartbeat");
    const taskId = submitted.tasks[0]!.taskId;
    const deadline = scheduler.activeTimeouts()[0]!;

    scheduler.setTime(scheduler.currentTime + 321);
    startedJob!.onHeartbeat();
    const observed = new Date(scheduler.currentTime).toISOString();
    expect(coordinator.getTask(taskId).heartbeatAt).toBe(observed);

    scheduler.setTime(scheduler.currentTime - 1);
    startedJob!.onHeartbeat();
    expect(coordinator.getTask(taskId).heartbeatAt).toBe(observed);

    scheduler.setTime(Date.parse(observed));
    startedJob!.onHeartbeat();
    expect(coordinator.getTask(taskId).heartbeatAt).toBe(observed);

    scheduler.setTime(scheduler.currentTime + 333);
    scheduler.fireInterval(1_234);
    expect(coordinator.getTask(taskId).heartbeatAt).toBe(new Date(scheduler.currentTime).toISOString());
    expect(scheduler.activeTimeouts()).toEqual([deadline]);

    await coordinator.stop();
    expect(scheduler.activeIntervals()).toEqual([]);
    expect(scheduler.activeTimeouts()).toEqual([]);
  } finally {
    await coordinator.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("graceful stop awaits active cleanup, leaves queued work for restart, and clears timers", async () => {
  const { root, config, store } = fixtureRoot("ccweb-research-graceful-stop-", { maxConcurrency: 1 });
  const scheduler = new ManualScheduler();
  let cleanupFinished = false;
  let stopReason: unknown;
  const first = new ResearchCoordinator(config, store, job => {
    job.onPartial("visible before stop");
    return new Promise<ResearchExecutorResult>((_resolve, reject) => {
      job.signal.addEventListener("abort", () => {
        stopReason = job.signal.reason;
        reject(job.signal.reason);
      }, { once: true });
    }).finally(() => {
      cleanupFinished = true;
    });
  }, new Set(["provider/model-fast"]), scheduler.options);
  let submitted: Awaited<ReturnType<ResearchCoordinator["submitBatch"]>>;
  try {
    first.start();
    submitted = await first.submitBatch(request([
      { clientKey: "active", description: "active during stop" },
      { clientKey: "queued", description: "queued during stop" },
    ]), "idem-1234567890-graceful-stop");
    await first.stop();

    expect(cleanupFinished).toBeTrue();
    expect(stopReason).toBeInstanceOf(Error);
    expect((stopReason as Error).message).toContain("service");
    expect(first.getTask(submitted!.tasks[0]!.taskId)).toMatchObject({
      status: "interrupted",
      error: { code: "service_restarted" },
      artifacts: [{ kind: "partial_report", complete: false }],
    });
    expect(first.getTask(submitted!.tasks[1]!.taskId).status).toBe("queued");
    expect(scheduler.activeIntervals()).toEqual([]);
    expect(scheduler.activeTimeouts()).toEqual([]);

    const restartScheduler = new ManualScheduler();
    const recovered: string[] = [];
    const second = new ResearchCoordinator(config, store, async job => {
      recovered.push(job.taskId);
      writeFileSync(join(job.workspacePath, "report.md"), "# recovered\n", "utf8");
      return successfulResult();
    }, new Set(["provider/model-fast"]), restartScheduler.options);
    second.start();
    const settled = await second.waitForBatch(submitted!.batchId);
    expect(recovered).toEqual([submitted!.tasks[1]!.taskId]);
    expect(settled.tasks.map(task => task.status)).toEqual(["interrupted", "succeeded"]);
    await second.stop();
  } finally {
    await first.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart converts cancelling to interrupted and preserves terminal artifacts byte for byte", async () => {
  const { root, config, store } = fixtureRoot("ccweb-research-recovery-terminal-");
  const scheduler = new ManualScheduler();
  const batchId = "rb_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const cancelling = storedTask(store, "rt_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", batchId, "cancelling", "cancelling");
  const terminal = storedTask(store, "rt_ffffffffffffffffffffffffffffffff", batchId, "terminal", "succeeded");
  store.saveTask(cancelling);
  store.writePartialText(cancelling.taskId, "preserved cancelling output");
  const partial = store.publishArtifact(cancelling, "partial_report");
  const cancellingWithArtifact = { ...cancelling, artifacts: [partial] };
  store.saveTask(cancellingWithArtifact);
  store.saveTask(terminal);
  await Bun.write(join(terminal.workspacePath, "report.md"), "# preserved terminal report\n");
  const detailed = store.publishArtifact(terminal, "detailed_report");
  const restoredTerminal: ResearchTaskSnapshot = {
    ...terminal,
    finishedAt: "2026-09-24T00:00:02.000Z",
    report: {
      summary: "preserved",
      feasibility: { verdict: "feasible", notes: "" },
      evidence: [],
      risks: [],
      unknowns: ["fixture"],
      reportPath: "report.md",
    },
    artifacts: [detailed],
    error: null,
  };
  store.saveTask(restoredTerminal);
  store.saveBatch({
    protocolVersion: RESEARCH_PROTOCOL_VERSION,
    batchId,
    idempotencyKey: null,
    requestHash: "f".repeat(64),
    createdAt: "2026-09-24T00:00:00.000Z",
    taskIds: [cancelling.taskId, terminal.taskId],
  });
  let calls = 0;
  const coordinator = new ResearchCoordinator(config, store, async job => {
    calls += 1;
    await Bun.write(join(job.workspacePath, "report.md"), "# unexpected\n");
    return successfulResult();
  }, new Set(["provider/model-fast"]), scheduler.options);
  try {
    coordinator.start();
    const settled = await coordinator.waitForBatch(batchId);

    expect(calls).toBe(0);
    expect(settled.tasks[0]).toEqual({
      ...cancellingWithArtifact,
      status: "interrupted",
      finishedAt: new Date(scheduler.currentTime).toISOString(),
      error: { code: "service_restarted", message: "Research service restarted before completion" },
    });
    expect(settled.tasks[1]).toEqual(restoredTerminal);
    expect(readFileSync(restoredTerminal.artifacts[0]!.path, "utf8")).toBe("# preserved terminal report\n");
  } finally {
    await coordinator.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("independent batch results preserve input order and partial failure", async () => {
  const { root, config, store } = fixtureRoot("ccweb-research-batch-");
  const executor: ResearchExecutor = async job => {
    if (job.model.endsWith("slow")) throw new Error("synthetic failure");
    await Bun.write(join(job.workspacePath, "partial-report.md"), "# partial\n");
    await Bun.write(join(job.workspacePath, "report.md"), "# report\n");
    return successfulResult();
  };
  const coordinator = new ResearchCoordinator(config, store, executor, new Set([
    "provider/model-fast",
    "provider/model-slow",
  ]));
  try {
    await coordinator.start();
    const submitted = await coordinator.submitBatch(request([
      { clientKey: "one", description: "one", model: "provider/model-fast" },
      { clientKey: "two", description: "two", model: "provider/model-slow" },
    ]), "idem-1234567891");
    const settled = await coordinator.waitForBatch(submitted.batchId);
    expect(settled.tasks.map(task => task.status)).toEqual(["succeeded", "failed"]);
    expect(settled.tasks[1]?.error?.code).toBe("executor_crashed");
  } finally {
    await coordinator.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("timeout and cancellation wait for abort, preserve partial output, and never publish a final report", async () => {
  const { root, config, store } = fixtureRoot("ccweb-research-stop-");
  const timers = manualDeadline();
  const started: ResearchExecutorJob[] = [];
  const executor: ResearchExecutor = job => {
    started.push(job);
    job.onPartial("visible checkpoint");
    return new Promise((_resolve, reject) => {
      job.signal.addEventListener("abort", () => reject(job.signal.reason), { once: true });
    });
  };
  const coordinator = new ResearchCoordinator(
    config,
    store,
    executor,
    new Set(["provider/model-fast"]),
    timers.options,
  );
  try {
    await coordinator.start();
    const timed = await coordinator.submitBatch(request([
      { clientKey: "timeout", description: "hang", timeoutMs: 1_000 },
    ]), "idem-1234567892");
    expect(started).toHaveLength(1);
    started[0]!.onHeartbeat();
    expect(store.getTask(timed.tasks[0]!.taskId)?.heartbeatAt).not.toBeNull();
    timers.fire();
    const timedResult = (await coordinator.waitForBatch(timed.batchId)).tasks[0]!;
    expect(timedResult).toMatchObject({
      status: "timed_out",
      error: { code: "deadline_exceeded" },
      artifacts: [{ kind: "partial_report", complete: false }],
    });
    expect(timedResult.artifacts.some(artifact => artifact.kind === "detailed_report")).toBeFalse();
    expect(timers.scheduler.activeIntervals()).toEqual([]);
    expect(timers.scheduler.activeTimeouts()).toEqual([]);

    const cancelled = await coordinator.submitBatch(request([
      { clientKey: "cancel", description: "hang", timeoutMs: 1_000 },
    ]), "idem-1234567893");
    expect(started).toHaveLength(2);
    const result = await coordinator.cancelTask(cancelled.tasks[0]!.taskId);
    expect(result).toMatchObject({
      status: "cancelled",
      error: { code: "cancelled" },
      artifacts: [{ kind: "partial_report", complete: false }],
    });
    expect(timers.scheduler.activeIntervals()).toEqual([]);
    expect(timers.scheduler.activeTimeouts()).toEqual([]);
  } finally {
    await coordinator.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("partial output persistence errors preserve their typed code", async () => {
  const { root, config } = fixtureRoot("ccweb-research-partial-error-");
  const store = new FailingResearchStore(config.workspaceRoot, () => false, new ResearchError("resource_error", "resource_error: injected partial failure", 500));
  store.writePartialText = () => {
    throw new ResearchError("resource_error", "resource_error: injected partial failure", 500);
  };
  const coordinator = new ResearchCoordinator(config, store, async job => {
    job.onPartial("visible");
    await Bun.write(join(job.workspacePath, "report.md"), "# report\n");
    return successfulResult();
  }, new Set(["provider/model-fast"]));
  try {
    const submitted = await coordinator.submitBatch(request([{ clientKey: "partial", description: "partial" }]), "idem-partial-error");
    const task = (await coordinator.waitForBatch(submitted.batchId)).tasks[0]!;
    expect(task).toMatchObject({ status: "failed", error: { code: "resource_error" } });
  } finally {
    await coordinator.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("running-state persistence failure settles as a stable resource error", async () => {
  const { root, config } = fixtureRoot("ccweb-research-running-save-");
  const runningAttempt = deferred<void>();
  const store = new FailingResearchStore(config.workspaceRoot, task => {
    if (task.status !== "running") return false;
    runningAttempt.resolve();
    return true;
  });
  const timers = manualDeadline();
  const coordinator = new ResearchCoordinator(config, store, async job => {
    await Bun.write(join(job.workspacePath, "report.md"), "# report\n");
    return successfulResult();
  }, new Set(["provider/model-fast"]), {
    ...timers.options,
    sleep: async () => { throw new Error("waitForBatch kept polling after settlement"); },
  });
  try {
    const submitted = await coordinator.submitBatch(request([
      { clientKey: "running-save", description: "running save fails" },
    ]), "idem-1234567890-running-save");
    await runningAttempt.promise;
    await flushMicrotasks();

    const task = (await coordinator.waitForBatch(submitted.batchId)).tasks[0]!;
    expect(task).toMatchObject({ status: "failed", error: { code: "resource_error" } });
  } finally {
    await coordinator.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("deadline persistence failure still aborts, preserves the timeout terminal, and rejects with resource_error", async () => {
  const { root, config } = fixtureRoot("ccweb-research-deadline-save-");
  const terminalSave = deferred<void>();
  const store = new FailingResearchStore(config.workspaceRoot, task => {
    if (task.status === "cancelling") return true;
    if (task.status === "timed_out") terminalSave.resolve();
    return false;
  });
  const timers = manualDeadline();
  let startedJob: ResearchExecutorJob | undefined;
  const coordinator = new ResearchCoordinator(config, store, job => {
    startedJob = job;
    return new Promise((_resolve, reject) => {
      job.signal.addEventListener("abort", () => reject(job.signal.reason), { once: true });
    });
  }, new Set(["provider/model-fast"]), timers.options);
  try {
    const submitted = await coordinator.submitBatch(request([
      { clientKey: "deadline-save", description: "deadline save fails" },
    ]), "idem-1234567890-deadline-save");
    timers.fire();
    await terminalSave.promise;
    await flushMicrotasks();

    expect(startedJob?.signal.aborted).toBeTrue();
    await expect(coordinator.waitForBatch(submitted.batchId)).rejects.toMatchObject({
      code: "resource_error",
      httpStatus: 500,
    });
    expect(coordinator.getTask(submitted.tasks[0]!.taskId)).toMatchObject({
      status: "timed_out",
      error: { code: "deadline_exceeded" },
    });
  } finally {
    await coordinator.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancellation persistence failure still aborts and settles as cancelled", async () => {
  const { root, config } = fixtureRoot("ccweb-research-cancel-save-");
  let cancellationFailures = 0;
  const store = new FailingResearchStore(config.workspaceRoot, task => {
    if (task.status !== "cancelling") return false;
    cancellationFailures += 1;
    return cancellationFailures === 1;
  });
  const timers = manualDeadline();
  let startedJob: ResearchExecutorJob | undefined;
  const coordinator = new ResearchCoordinator(config, store, job => {
    startedJob = job;
    return new Promise((_resolve, reject) => {
      job.signal.addEventListener("abort", () => reject(job.signal.reason), { once: true });
    });
  }, new Set(["provider/model-fast"]), timers.options);
  try {
    const submitted = await coordinator.submitBatch(request([
      { clientKey: "cancel-save", description: "cancel save fails" },
    ]), "idem-1234567890-cancel-save");
    const taskId = submitted.tasks[0]!.taskId;

    await expect(coordinator.cancelTask(taskId)).rejects.toMatchObject({
      code: "resource_error",
      httpStatus: 500,
    });
    expect(startedJob?.signal.aborted).toBeTrue();
    expect(coordinator.getTask(taskId)).toMatchObject({
      status: "cancelled",
      error: { code: "cancelled" },
    });
  } finally {
    await coordinator.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("graceful-stop persistence failure still aborts and rejects with resource_error", async () => {
  const { root, config } = fixtureRoot("ccweb-research-stop-save-");
  let cancellationFailures = 0;
  const store = new FailingResearchStore(config.workspaceRoot, task => {
    if (task.status !== "cancelling") return false;
    cancellationFailures += 1;
    return cancellationFailures === 1;
  });
  const timers = manualDeadline();
  let startedJob: ResearchExecutorJob | undefined;
  const coordinator = new ResearchCoordinator(config, store, job => {
    startedJob = job;
    return new Promise((_resolve, reject) => {
      job.signal.addEventListener("abort", () => reject(job.signal.reason), { once: true });
    });
  }, new Set(["provider/model-fast"]), timers.options);
  try {
    const submitted = await coordinator.submitBatch(request([
      { clientKey: "stop-save", description: "stop save fails" },
    ]), "idem-1234567890-stop-save");
    const taskId = submitted.tasks[0]!.taskId;

    await expect(coordinator.stop()).rejects.toMatchObject({
      code: "resource_error",
      httpStatus: 500,
    });
    expect(startedJob?.signal.aborted).toBeTrue();
    expect(coordinator.getTask(taskId)).toMatchObject({
      status: "interrupted",
      error: { code: "service_restarted" },
    });
  } finally {
    await coordinator.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("final persistence failure rejects batch waiters with a stable resource error", async () => {
  const { root, config } = fixtureRoot("ccweb-research-final-save-");
  const terminalAttempt = deferred<void>();
  const store = new FailingResearchStore(config.workspaceRoot, task => {
    if (task.status !== "succeeded") return false;
    terminalAttempt.resolve();
    return true;
  }, new Error("injected raw final save failure"));
  const timers = manualDeadline();
  const coordinator = new ResearchCoordinator(config, store, async job => {
    await Bun.write(join(job.workspacePath, "report.md"), "# report\n");
    return successfulResult();
  }, new Set(["provider/model-fast"]), {
    ...timers.options,
    sleep: async () => { throw new Error("waitForBatch kept polling after settlement"); },
  });
  try {
    const submitted = await coordinator.submitBatch(request([
      { clientKey: "final-save", description: "final save fails" },
    ]), "idem-1234567890-final-save");
    await terminalAttempt.promise;
    await flushMicrotasks();

    await expect(coordinator.waitForBatch(submitted.batchId)).rejects.toMatchObject({
      code: "resource_error",
      httpStatus: 500,
    });
  } finally {
    await coordinator.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("late executor rejection preserves externally persisted interrupted and cancelled snapshots", async () => {
  const { root, config, store } = fixtureRoot("ccweb-research-terminal-race-");
  const jobs: ResearchExecutorJob[] = [];
  const gates: Array<ReturnType<typeof deferred<ResearchExecutorResult>>> = [];
  const coordinator = new ResearchCoordinator(config, store, job => {
    jobs.push(job);
    job.onPartial(`visible ${job.taskId}`);
    const gate = deferred<ResearchExecutorResult>();
    gates.push(gate);
    return gate.promise;
  }, new Set(["provider/model-fast"]));
  try {
    const submitted = await coordinator.submitBatch(request([
      { clientKey: "interrupted", description: "externally interrupted" },
      { clientKey: "cancelled", description: "externally cancelled" },
    ]), "idem-1234567890-terminal-race");
    const external: ResearchTaskSnapshot[] = [];

    for (const [index, status] of (["interrupted", "cancelled"] as const).entries()) {
      const running = store.getTask(submitted.tasks[index]!.taskId)!;
      const artifact = store.publishArtifact(running, "partial_report");
      const terminal: ResearchTaskSnapshot = {
        ...running,
        status,
        finishedAt: new Date(Date.parse("2026-09-24T00:00:01.000Z") + index).toISOString(),
        artifacts: [artifact],
        error: status === "interrupted"
          ? { code: "service_restarted", message: "external interruption" }
          : { code: "cancelled", message: "external cancellation" },
      };
      store.saveTask(terminal);
      external.push(terminal);
      gates[index]!.reject(new Error(`late rejection ${status}`));
    }
    await coordinator.stop();

    const settled = await coordinator.waitForBatch(submitted.batchId);
    expect(settled.tasks).toEqual(external);
    expect(jobs).toHaveLength(2);
  } finally {
    await coordinator.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart interrupts running work without rerunning it and separately resumes a persisted queued task", async () => {
  const { root, config, store } = fixtureRoot("ccweb-research-recovery-");
  let calls = 0;
  const executor: ResearchExecutor = async job => {
    calls += 1;
    job.onPartial("first");
    await Bun.write(join(job.workspacePath, "report.md"), "# report\n");
    return calls === 1 ? { finalText: "not-json" } : successfulResult();
  };
  const first = new ResearchCoordinator(config, store, executor, new Set(["provider/model-fast"]));
  await first.start();
  const submitted = await first.submitBatch(request([
    { clientKey: "one", description: "one" },
  ]), "idem-1234567894");
  const settled = await first.waitForBatch(submitted.batchId);
  expect(settled.tasks[0]).toMatchObject({
    status: "failed",
    error: { code: "invalid_report" },
  });
  expect(settled.tasks[0]?.artifacts.some(artifact => artifact.kind === "detailed_report")).toBeFalse();
  expect(calls).toBe(1);
  const running = store.getTask(settled.tasks[0]!.taskId)!;
  store.saveTask({ ...running, status: "running", finishedAt: null, error: null, report: null, artifacts: [] });

  const queuedId = "rt_cccccccccccccccccccccccccccccccc";
  const queuedBatchId = "rb_dddddddddddddddddddddddddddddddd";
  store.saveTask({
    ...running,
    taskId: queuedId,
    batchId: queuedBatchId,
    status: "queued",
    startedAt: null,
    finishedAt: null,
    heartbeatAt: null,
    workspacePath: store.workspacePath(queuedId),
    artifacts: [],
  });
  store.saveBatch({
    protocolVersion: RESEARCH_PROTOCOL_VERSION,
    batchId: queuedBatchId,
    idempotencyKey: null,
    requestHash: "f".repeat(64),
    createdAt: running.createdAt,
    taskIds: [queuedId],
  });

  const second = new ResearchCoordinator(config, store, executor, new Set(["provider/model-fast"]));
  try {
    await second.start();
    expect(second.getTask(running.taskId)).toMatchObject({
      status: "interrupted",
      error: { code: "service_restarted" },
      artifacts: [{ kind: "partial_report", complete: false }],
    });
    expect((await second.waitForBatch(queuedBatchId)).tasks[0]?.status).toBe("succeeded");
    expect(calls).toBe(2);
  } finally {
    await second.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
