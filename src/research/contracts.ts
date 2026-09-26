import { z } from "zod";

export const RESEARCH_PROTOCOL_VERSION = "research-delegation/v1" as const;
export const RESEARCH_TASK_ID_PATTERN = /^rt_[a-f0-9]{32}$/;
export const RESEARCH_BATCH_ID_PATTERN = /^rb_[a-f0-9]{32}$/;
export const RESEARCH_MODEL_PATTERN = /^[^/\s]+\/[^/\s]+$/;

const ClientKeySchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const ModelSchema = z.string().trim().min(3).max(200).regex(RESEARCH_MODEL_PATTERN);
const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const HttpUrlSchema = z.string().url({ protocol: /^https?$/ });

export const ResearchTaskInputSchema = z.object({
  clientKey: ClientKeySchema.optional(),
  description: z.string().trim().min(1).max(32_000),
  model: ModelSchema.optional(),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).optional(),
}).strict();

export const ResearchBatchRequestSchema = z.object({
  protocolVersion: z.literal(RESEARCH_PROTOCOL_VERSION),
  tasks: z.array(ResearchTaskInputSchema).min(1).max(16),
}).strict().superRefine((request, context) => {
  const seen = new Set<string>();
  for (const task of request.tasks) {
    if (!task.clientKey) continue;
    if (seen.has(task.clientKey)) {
      context.addIssue({
        code: "custom",
        message: "clientKey values must be unique within a batch",
        path: ["tasks"],
      });
    }
    seen.add(task.clientKey);
  }
});

export const ResearchReportSchema = z.object({
  summary: z.string().trim().min(1).max(20_000),
  feasibility: z.object({
    verdict: z.enum(["feasible", "partially_feasible", "infeasible", "unknown"]),
    notes: z.string().trim().max(10_000),
  }).strict(),
  evidence: z.array(z.object({
    claim: z.string().trim().min(1).max(4_000),
    source: HttpUrlSchema,
    observedAt: IsoDateSchema.optional(),
  }).strict()).max(100),
  risks: z.array(z.string().trim().min(1).max(4_000)).max(100),
  unknowns: z.array(z.string().trim().min(1).max(4_000)).max(100),
  reportPath: z.string().min(1).max(256),
}).strict().superRefine((report, context) => {
  if (report.reportPath !== "report.md") {
    context.addIssue({
      code: "custom",
      message: "reportPath must be report.md",
      path: ["reportPath"],
    });
  }
  if (report.evidence.length === 0 && report.unknowns.length === 0) {
    context.addIssue({
      code: "custom",
      message: "unknowns must explain the evidence gap when evidence is empty",
      path: ["unknowns"],
    });
  }
});

export type ResearchTaskInput = z.infer<typeof ResearchTaskInputSchema>;
export type ResearchBatchRequest = z.infer<typeof ResearchBatchRequestSchema>;
export type ResearchReport = z.infer<typeof ResearchReportSchema>;
export type ResearchTaskStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "interrupted";
export type ResearchTerminalStatus = Extract<ResearchTaskStatus,
  "succeeded" | "failed" | "timed_out" | "cancelled" | "interrupted">;
export type ResearchArtifactKind = "detailed_report" | "partial_report";
export type ResearchErrorCode =
  | "idempotency_conflict"
  | "model_unavailable"
  | "executor_launch"
  | "executor_failed"
  | "executor_crashed"
  | "invalid_report"
  | "unsafe_report_path"
  | "deadline_exceeded"
  | "cancelled"
  | "service_restarted"
  | "resource_error";

export interface ResearchArtifact {
  kind: ResearchArtifactKind;
  path: string;
  sizeBytes: number;
  sha256: string;
  complete: boolean;
}

export interface ResearchTaskError {
  code: ResearchErrorCode;
  message: string;
}

export interface ResearchTaskSnapshot {
  protocolVersion: typeof RESEARCH_PROTOCOL_VERSION;
  taskId: string;
  batchId: string;
  clientKey?: string;
  description: string;
  effectiveModel: string;
  timeoutMs: number;
  status: ResearchTaskStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  heartbeatAt: string | null;
  workspacePath: string;
  report: ResearchReport | null;
  artifacts: ResearchArtifact[];
  error: ResearchTaskError | null;
}

export interface ResearchBatchRecord {
  protocolVersion: typeof RESEARCH_PROTOCOL_VERSION;
  batchId: string;
  idempotencyKey: string | null;
  requestHash: string;
  createdAt: string;
  taskIds: string[];
}

export interface ResearchIdempotencyRecord {
  key: string;
  requestHash: string;
  batchId: string;
  createdAt: string;
}

export type ResearchSubmissionPhase = "prepared" | "committed" | "aborted";

export interface ResearchSubmissionRecord {
  protocolVersion: typeof RESEARCH_PROTOCOL_VERSION;
  phase: ResearchSubmissionPhase;
  batch: ResearchBatchRecord;
  idempotency: ResearchIdempotencyRecord | null;
  tasks: ResearchTaskSnapshot[];
  createdAt: string;
}

export interface ResearchBatchSnapshot {
  protocolVersion: typeof RESEARCH_PROTOCOL_VERSION;
  batchId: string;
  waitCompleted: boolean;
  tasks: ResearchTaskSnapshot[];
}

export interface ResearchExecutorJob {
  taskId: string;
  workspacePath: string;
  model: string;
  prompt: string;
  signal: AbortSignal;
  onHeartbeat: () => void;
  onPartial: (text: string) => void;
}

export interface ResearchExecutorResult {
  finalText: string;
  sessionId?: string;
}

export type ResearchExecutor = (job: ResearchExecutorJob) => Promise<ResearchExecutorResult>;

export class ResearchError extends Error {
  constructor(
    public readonly code: ResearchErrorCode,
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message);
    this.name = "ResearchError";
  }
}

export function isResearchTerminalStatus(status: ResearchTaskStatus): status is ResearchTerminalStatus {
  return status === "succeeded"
    || status === "failed"
    || status === "timed_out"
    || status === "cancelled"
    || status === "interrupted";
}
