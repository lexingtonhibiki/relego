import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RESEARCH_PROTOCOL_VERSION, type ResearchExecutor } from "./contracts";
import type { ResearchConfig } from "./config";
import { createOpenCodeExecutor, probeOpenCode, type OpenCodeCapabilities } from "./opencode";
import { startResearchService } from "./service";

export interface ResearchSmokeDependencies {
  probe?: (command: [string, ...string[]], model: string) => OpenCodeCapabilities;
  executor?: ResearchExecutor;
}

export async function runResearchLiveSmoke(
  base: ResearchConfig,
  dependencies: ResearchSmokeDependencies = {},
): Promise<{ status: string; taskId: string; model: string; reportPath: string; artifacts: unknown[] }> {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "ccweb-research-live-smoke-"));
  const config = { ...base, port: 0, workspaceRoot: join(temporaryRoot, "jobs") };
  let service: ReturnType<typeof startResearchService> | undefined;
  let succeeded = false;
  try {
    const capabilities = (dependencies.probe ?? probeOpenCode)(config.opencodeCommand, config.defaultModel);
    service = startResearchService(config, {
      executor: dependencies.executor ?? createOpenCodeExecutor(capabilities),
      models: new Set(capabilities.models),
    });
    const submitted = await service.coordinator.submitBatch({
      protocolVersion: RESEARCH_PROTOCOL_VERSION,
      tasks: [{
        clientKey: "live-smoke",
        description: "Use only these inline facts and do not browse: Project Cedar is version 1.2.3 and supports offline reports. Produce a feasibility report.",
        model: base.defaultModel,
        timeoutMs: base.defaultTimeoutMs,
      }],
    }, randomUUID());
    const result = await service.coordinator.waitForBatch(submitted.batchId);
    const task = result.tasks[0];
    if (!task || task.status !== "succeeded" || !task.report) {
      throw new Error(`Live research smoke failed: ${JSON.stringify(task)}`);
    }
    succeeded = true;
    return {
      status: task.status,
      taskId: task.taskId,
      model: task.effectiveModel,
      reportPath: join(task.workspacePath, "report.md"),
      artifacts: task.artifacts,
    };
  } finally {
    if (service) await service.stop();
    if (succeeded) {
      rmSync(temporaryRoot, { recursive: true, force: true });
    } else {
      process.stdout.write(`smoke workspace preserved for diagnosis: ${temporaryRoot}
`);
    }
  }
}
