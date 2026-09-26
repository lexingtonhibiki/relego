import { createHash, randomBytes } from "node:crypto";
import {
  RESEARCH_PROTOCOL_VERSION,
  ResearchError,
  isResearchTerminalStatus,
  type ResearchArtifact,
  type ResearchBatchRequest,
  type ResearchBatchRecord,
  type ResearchBatchSnapshot,
  type ResearchErrorCode,
  type ResearchIdempotencyRecord,
  type ResearchExecutor,
  type ResearchSubmissionRecord,
  type ResearchTaskSnapshot,
  type ResearchTaskStatus,
} from "./contracts";
import type { ResearchConfig } from "./config";
import { buildResearchPrompt } from "./opencode";
import { parseResearchReport } from "./report";
import type { ResearchStore } from "./store";

interface ActiveTask {
  controller: AbortController;
  stopReason: "deadline_exceeded" | "cancelled" | "service_restarted" | null;
  done: Promise<void>;
  resolveDone: () => void;
  rejectDone: (error: unknown) => void;
  failure: ResearchError | null;
}

export interface ResearchCoordinatorOptions {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  setTimeout?: (handler: () => void, timeout: number) => number;
  clearTimeout?: (handle: number) => void;
  setInterval?: (handler: () => void, timeout: number) => number;
  clearInterval?: (handle: number) => void;
}

function randomId(prefix: "rt" | "rb"): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

function requestHash(request: ResearchBatchRequest, config: ResearchConfig): string {
  const normalized = {
    protocolVersion: request.protocolVersion,
    tasks: request.tasks.map(task => ({
      ...(task.clientKey === undefined ? {} : { clientKey: task.clientKey }),
      description: task.description,
      model: task.model ?? config.defaultModel,
      timeoutMs: task.timeoutMs ?? config.defaultTimeoutMs,
    })),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function lifecycleError(error: unknown): ResearchError {
  if (error instanceof ResearchError) return error;
  return new ResearchError(
    "resource_error",
    `resource_error: ${error instanceof Error ? error.message : String(error)}`,
    500,
  );
}

function terminalForStop(reason: ActiveTask["stopReason"]): {
  status: ResearchTaskStatus;
  code: ResearchErrorCode;
  message: string;
} {
  if (reason === "deadline_exceeded") {
    return { status: "timed_out", code: "deadline_exceeded", message: "Task exceeded its absolute deadline" };
  }
  if (reason === "cancelled") {
    return { status: "cancelled", code: "cancelled", message: "Task was cancelled" };
  }
  if (reason === "service_restarted") {
    return { status: "interrupted", code: "service_restarted", message: "Research service stopped before completion" };
  }
  throw new Error("Terminal stop reason is missing");
}

function mergeArtifacts(
  existing: ResearchTaskSnapshot["artifacts"],
  additions: ResearchTaskSnapshot["artifacts"],
): ResearchTaskSnapshot["artifacts"] {
  const merged = [...existing];
  for (const artifact of additions) {
    const index = merged.findIndex(candidate => candidate.kind === artifact.kind);
    if (index < 0) merged.push(artifact);
    else merged[index] = artifact;
  }
  return merged;
}

export class ResearchCoordinator {
  private readonly active = new Map<string, ActiveTask>();
  private readonly executionFailures = new Map<string, ResearchError>();
  private queued: string[] = [];
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly setTimeout: (handler: () => void, timeout: number) => number;
  private readonly clearTimeout: (handle: number) => void;
  private readonly setInterval: (handler: () => void, timeout: number) => number;
  private readonly clearInterval: (handle: number) => void;
  private started = false;
  private stopping = false;

  constructor(
    private readonly config: ResearchConfig,
    private readonly store: ResearchStore,
    private readonly executor: ResearchExecutor,
    private readonly availableModels: ReadonlySet<string>,
    options: ResearchCoordinatorOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (milliseconds => Bun.sleep(milliseconds));
    this.setTimeout = options.setTimeout ?? ((handler, timeout) => globalThis.setTimeout(handler, timeout) as unknown as number);
    this.clearTimeout = options.clearTimeout ?? (handle => globalThis.clearTimeout(handle));
    this.setInterval = options.setInterval ?? ((handler, timeout) => globalThis.setInterval(handler, timeout) as unknown as number);
    this.clearInterval = options.clearInterval ?? (handle => globalThis.clearInterval(handle));
  }

  start(): void {
    if (this.started) return;
    for (const submission of this.store.listSubmissions()) {
      if (submission.phase === "prepared") this.abortSubmission(submission);
    }
    for (const task of this.store.listTasks()) {
      if (task.status !== "succeeded") this.store.removeArtifact(task.taskId, "detailed_report");
      if (task.status === "queued") {
        this.queued.push(task.taskId);
        continue;
      }
      if (task.status === "running" || task.status === "cancelling") {
        let artifacts = task.artifacts.filter(artifact => artifact.kind !== "detailed_report");
        if (this.store.hasPartialReport(task.taskId)) {
          artifacts = mergeArtifacts(artifacts, [this.store.publishArtifact(task, "partial_report")]);
        }
        this.store.saveTask({
          ...this.finishTerminal(task, {
            status: "interrupted",
            code: "service_restarted",
            message: "Research service restarted before completion",
          }),
          artifacts,
        });
      }
    }
    this.started = true;
    this.pump();
  }

  async submitBatch(
    request: ResearchBatchRequest,
    idempotencyKey?: string,
  ): Promise<ResearchBatchSnapshot> {
    const hash = requestHash(request, this.config);
    if (idempotencyKey) {
      const existing = this.store.getIdempotency(idempotencyKey)
        ?? this.store.findSubmissionByIdempotency(idempotencyKey)?.idempotency;
      if (existing) {
        if (existing.requestHash !== hash) {
          throw new ResearchError("idempotency_conflict", "Idempotency key was reused with a different request", 409);
        }
        return this.getBatchSnapshot(existing.batchId, true);
      }
    }

    const effectiveModels = request.tasks.map(task => task.model ?? this.config.defaultModel);
    const missing = [...new Set(effectiveModels.filter(model => !this.availableModels.has(model)))];
    if (missing.length > 0) {
      throw new ResearchError("model_unavailable", `model_unavailable: OpenCode model is unavailable: ${missing.join(", ")}`, 400);
    }

    const batchId = randomId("rb");
    const createdAt = new Date(this.now()).toISOString();
    const tasks = request.tasks.map((task, index) => {
      const taskId = randomId("rt");
      return {
        protocolVersion: RESEARCH_PROTOCOL_VERSION,
        taskId,
        batchId,
        ...(task.clientKey ? { clientKey: task.clientKey } : {}),
        description: task.description,
        effectiveModel: effectiveModels[index]!,
        timeoutMs: task.timeoutMs ?? this.config.defaultTimeoutMs,
        status: "queued",
        createdAt,
        startedAt: null,
        finishedAt: null,
        heartbeatAt: null,
        workspacePath: this.store.workspacePath(taskId),
        report: null,
        artifacts: [],
        error: null,
      } satisfies ResearchTaskSnapshot;
    });
    const batch: ResearchBatchRecord = {
      protocolVersion: RESEARCH_PROTOCOL_VERSION,
      batchId,
      idempotencyKey: idempotencyKey ?? null,
      requestHash: hash,
      createdAt,
      taskIds: tasks.map(task => task.taskId),
    };
    const idempotency: ResearchIdempotencyRecord | null = idempotencyKey
      ? { key: idempotencyKey, requestHash: hash, batchId, createdAt }
      : null;
    const submission: ResearchSubmissionRecord = {
      protocolVersion: RESEARCH_PROTOCOL_VERSION,
      phase: "prepared",
      batch,
      idempotency,
      tasks,
      createdAt,
    };
    this.store.saveSubmission(submission);
    try {
      for (const task of tasks) this.store.saveTask(task);
      this.store.saveBatch(batch);
      if (idempotency) this.store.saveIdempotency(idempotency);
      this.store.saveSubmission({ ...submission, phase: "committed" });
    } catch (error) {
      try { this.abortSubmission(submission); } catch {}
      throw lifecycleError(error);
    }
    const submissionAfterWrite = this.store.getSubmission(batchId);
    if (!submissionAfterWrite || submissionAfterWrite.phase !== "committed") {
      throw new ResearchError("resource_error", "resource_error: Research submission was not durably committed", 500);
    }
    for (const task of tasks) this.queued.push(task.taskId);
    this.pump();
    return this.getBatchSnapshot(batchId, false);
  }

  private abortSubmission(submission: ResearchSubmissionRecord): void {
    if (submission.phase !== "prepared") return;
    const now = new Date(this.now()).toISOString();
    for (const task of submission.tasks) {
      const current = this.store.getTask(task.taskId);
      if (current && !isResearchTerminalStatus(current.status)) {
        this.store.saveTask({
          ...current,
          status: "interrupted",
          finishedAt: now,
          error: { code: "resource_error", message: "Research submission was incomplete" },
        });
      } else if (!current) {
        this.store.saveTask({
          ...task,
          status: "interrupted",
          finishedAt: now,
          error: { code: "resource_error", message: "Research submission was incomplete" },
        });
      }
    }
    try { this.store.saveBatch(submission.batch); } catch {}
    if (submission.idempotency) {
      try { this.store.saveIdempotency(submission.idempotency); } catch {}
    }
    try { this.store.saveSubmission({ ...submission, phase: "aborted" }); } catch {}
  }

  getTask(taskId: string): ResearchTaskSnapshot {
    const task = this.store.getTask(taskId);
    if (!task) throw new ResearchError("resource_error", `Research task not found: ${taskId}`, 404);
    return task;
  }

  getBatchSnapshot(batchId: string, waitCompleted = false): ResearchBatchSnapshot {
    const batch = this.store.getBatch(batchId);
    if (!batch) throw new ResearchError("resource_error", `Research batch not found: ${batchId}`, 404);
    const tasks = batch.taskIds.map(taskId => this.getTask(taskId));
    return {
      protocolVersion: RESEARCH_PROTOCOL_VERSION,
      batchId,
      waitCompleted: waitCompleted && tasks.every(task => isResearchTerminalStatus(task.status)),
      tasks,
    };
  }

  async waitForBatch(batchId: string): Promise<ResearchBatchSnapshot> {
    for (;;) {
      const snapshot = this.getBatchSnapshot(batchId, true);
      const failure = snapshot.tasks
        .map(task => this.executionFailures.get(task.taskId))
        .find((candidate): candidate is ResearchError => candidate !== undefined);
      if (failure) throw failure;
      if (snapshot.tasks.every(task => isResearchTerminalStatus(task.status))) return snapshot;
      await this.sleep(25);
    }
  }

  async cancelTask(taskId: string): Promise<ResearchTaskSnapshot> {
    const task = this.getTask(taskId);
    if (isResearchTerminalStatus(task.status)) return task;
    const active = this.active.get(taskId);
    if (!active) {
      const cancelled = this.finishTerminal(task, {
        status: "cancelled",
        code: "cancelled",
        message: "Task was cancelled before execution",
      });
      this.store.saveTask(cancelled);
      this.queued = this.queued.filter(queuedId => queuedId !== taskId);
      return cancelled;
    }
    if (active.stopReason) {
      await active.done;
      return this.getTask(taskId);
    }
    active.stopReason = "cancelled";
    try {
      this.store.saveTask({ ...this.getTask(taskId), status: "cancelling" });
    } catch (error) {
      this.recordFailure(active, error);
    } finally {
      active.controller.abort(new Error("Research task cancelled"));
    }
    await active.done;
    return this.getTask(taskId);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const active = [...this.active.entries()];
    for (const [taskId, item] of active) {
      if (item.stopReason) continue;
      try {
        const task = this.store.getTask(taskId);
        if (!task || isResearchTerminalStatus(task.status)) continue;
        item.stopReason = "service_restarted";
        this.store.saveTask({ ...task, status: "cancelling" });
      } catch (error) {
        item.stopReason = "service_restarted";
        this.recordFailure(item, error);
      } finally {
        if (item.stopReason) item.controller.abort(new Error("Research service stopped"));
      }
    }
    const results = await Promise.allSettled(active.map(([, item]) => item.done));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw lifecycleError(failure.reason);
  }

  private pump(): void {
    while (!this.stopping && this.active.size < this.config.maxConcurrency) {
      const taskId = this.queued.shift();
      if (!taskId) return;
      const task = this.store.getTask(taskId);
      if (!task || task.status !== "queued") continue;
      let resolveDone!: () => void;
      let rejectDone!: (error: unknown) => void;
      const done = new Promise<void>((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
      });
      void done.catch(() => {});
      const active: ActiveTask = {
        controller: new AbortController(),
        stopReason: null,
        done,
        resolveDone,
        rejectDone,
        failure: null,
      };
      this.active.set(taskId, active);
      const finish = () => {
        this.active.delete(taskId);
        if (active.failure) {
          this.executionFailures.set(taskId, active.failure);
          active.rejectDone(active.failure);
        } else {
          active.resolveDone();
        }
        this.pump();
      };
      void this.execute(task, active).then(finish, error => {
        active.failure ??= lifecycleError(error);
        finish();
      });
    }
  }

  private async execute(task: ResearchTaskSnapshot, active: ActiveTask): Promise<void> {
    const startedAt = new Date(this.now()).toISOString();
    let current: ResearchTaskSnapshot = {
      ...task,
      status: "running",
      startedAt,
      heartbeatAt: startedAt,
    };
    let detailedArtifact: ResearchArtifact | null = null;
    let heartbeat: number | undefined;
    let deadline: number | undefined;

    const liveTask = (): ResearchTaskSnapshot | undefined => {
      if (active.stopReason || current.status !== "running") return undefined;
      const persisted = this.store.getTask(current.taskId);
      return persisted?.status === "running" ? persisted : undefined;
    };
    const heartbeatNow = (): void => {
      try {
        const persisted = liveTask();
        if (!persisted) return;
        const heartbeatAt = new Date(this.now()).toISOString();
        const previous = Date.parse(persisted.heartbeatAt ?? "");
        const next = Date.parse(heartbeatAt);
        if (Number.isFinite(previous) && previous > next) return;
        current = { ...current, heartbeatAt };
        this.store.saveTask(current);
      } catch (error) {
        const failure = lifecycleError(error);
        this.recordFailure(active, failure);
        active.controller.abort(failure);
      }
    };

    try {
      this.store.saveTask(current);
      heartbeat = this.setInterval(heartbeatNow, this.config.heartbeatMs);
      deadline = this.setTimeout(() => {
        if (active.stopReason || current.status !== "running") return;
        active.stopReason = "deadline_exceeded";
        current = { ...current, status: "cancelling" };
        try {
          this.store.saveTask(current);
        } catch (error) {
          this.recordFailure(active, error);
        } finally {
          active.controller.abort(new Error("Research deadline exceeded"));
        }
      }, current.timeoutMs);

      const result = await this.executor({
        taskId: current.taskId,
        workspacePath: this.store.workspacePath(current.taskId),
        model: current.effectiveModel,
        prompt: buildResearchPrompt(current.description),
        signal: active.controller.signal,
        onHeartbeat: heartbeatNow,
        onPartial: text => {
          if (!liveTask()) return;
          this.store.writePartialText(current.taskId, text);
        },
      });
      if (active.stopReason) throw active.controller.signal.reason ?? new Error("Research task stopped");
      const persisted = this.store.getTask(current.taskId);
      if (persisted && persisted.status !== "running") {
        current = persisted;
        return;
      }
      const report = parseResearchReport(result.finalText, this.store.workspacePath(current.taskId));
      if (active.stopReason) throw active.controller.signal.reason ?? new Error("Research task stopped");
      const artifact = this.store.publishArtifact(current, "detailed_report");
      detailedArtifact = artifact;
      if (active.stopReason) throw active.controller.signal.reason ?? new Error("Research task stopped");
      current = {
        ...current,
        status: "succeeded",
        finishedAt: new Date(this.now()).toISOString(),
        report,
        artifacts: [artifact],
        error: null,
      };
    } catch (error) {
      const persisted = this.store.getTask(current.taskId);
      if (persisted && isResearchTerminalStatus(persisted.status)) {
        current = persisted;
        return;
      }
      if (isResearchTerminalStatus(current.status)) return;
      let artifacts = current.artifacts;
      try {
        if (this.store.hasPartialReport(current.taskId)) {
          artifacts = mergeArtifacts(artifacts, [this.store.publishArtifact(current, "partial_report")]);
        }
      } catch (artifactError) {
        error = artifactError;
      }
      if (active.stopReason) {
        current = this.finishTerminal(current, terminalForStop(active.stopReason));
      } else if (error instanceof ResearchError) {
        current = this.finishTerminal(current, {
          status: "failed",
          code: error.code,
          message: error.message,
        });
      } else {
        current = this.finishTerminal(current, {
          status: "failed",
          code: "executor_crashed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      current = { ...current, artifacts };
    } finally {
      if (heartbeat !== undefined) {
        try {
          this.clearInterval(heartbeat);
        } catch (error) {
          this.recordFailure(active, error);
        }
      }
      if (deadline !== undefined) {
        try {
          this.clearTimeout(deadline);
        } catch (error) {
          this.recordFailure(active, error);
        }
      }
      try {
        const persisted = this.store.getTask(current.taskId);
        if (persisted && isResearchTerminalStatus(persisted.status)) current = persisted;
        if (current.status !== "succeeded" && detailedArtifact) {
          try { this.store.removeArtifact(current.taskId, "detailed_report"); } catch {}
        }
        if (!persisted || !isResearchTerminalStatus(persisted.status)) this.store.saveTask(current);
      } catch (error) {
        if (detailedArtifact) {
          try { this.store.removeArtifact(current.taskId, "detailed_report"); } catch {}
        }
        throw lifecycleError(error);
      }
    }
  }

  private recordFailure(active: ActiveTask, error: unknown): void {
    active.failure ??= lifecycleError(error);
  }

  private finishTerminal(
    task: ResearchTaskSnapshot,
    terminal: { status: ResearchTaskStatus; code: ResearchErrorCode; message: string },
  ): ResearchTaskSnapshot {
    if (isResearchTerminalStatus(task.status)) return task;
    return {
      ...task,
      status: terminal.status,
      finishedAt: new Date(this.now()).toISOString(),
      error: { code: terminal.code, message: terminal.message },
    };
  }
}
