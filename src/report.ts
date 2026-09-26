import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ResearchError, ResearchReportSchema, type ResearchReport } from "./contracts";

function unsafePath(message: string): ResearchError {
  return new ResearchError("unsafe_report_path", `unsafe_report_path: ${message}`, 400);
}

function resourceError(message: string): ResearchError {
  return new ResearchError("resource_error", `resource_error: ${message}`, 500);
}

function assertContained(resolvedPath: string, resolvedRoot: string): void {
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return;
  throw unsafePath("Report path escapes the task workspace");
}

function realRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ResearchError("invalid_report", "invalid_report: Task workspace does not exist", 422);
    }
    throw resourceError("Unable to resolve the task workspace");
  }
}

function assertNoLinkedComponents(resolvedPath: string, resolvedRoot: string): void {
  assertContained(resolvedPath, resolvedRoot);
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel === "") return;
  let current = resolvedRoot;
  const segments = rel.split(sep);
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw resourceError("Unable to inspect the report path");
    }
    if (stats.isSymbolicLink()) throw unsafePath("Report path contains a symbolic link or junction");
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw unsafePath("Report path contains a non-directory component");
    }
    let real: string;
    try {
      real = realpathSync(current);
    } catch {
      throw resourceError("Unable to resolve the report path");
    }
    assertContained(real, resolvedRoot);
  }
}

export function assertRegularFileInside(path: string, root: string): string {
  const resolvedRoot = realRoot(root);
  const resolved = resolve(path);
  assertNoLinkedComponents(resolved, resolvedRoot);
  let link: ReturnType<typeof lstatSync>;
  try {
    link = lstatSync(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ResearchError("invalid_report", "invalid_report: Required report file does not exist", 422);
    }
    throw resourceError("Unable to inspect the detailed report");
  }
  if (!link.isFile() || link.isSymbolicLink()) {
    throw unsafePath("Report must be a regular file");
  }
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    throw resourceError("Unable to resolve the detailed report");
  }
  assertContained(real, resolvedRoot);
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(real);
  } catch {
    throw resourceError("Unable to inspect the detailed report");
  }
  if (!stats.isFile() || stats.size < 1) {
    throw new ResearchError("invalid_report", "invalid_report: Detailed report must be a non-empty regular file", 422);
  }
  return real;
}

function extractJsonReport(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {}
  // The binding contract says the final text must CONTAIN exactly one JSON
  // object; executors often prepend a prose sentence. The first-{-to-last-}
  // slice enforces exactly one balanced object: concatenated objects or stray
  // braces still fail closed.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new ResearchError("invalid_report", "invalid_report: OpenCode final text is not one JSON report", 422);
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new ResearchError("invalid_report", "invalid_report: OpenCode final text is not one JSON report", 422);
  }
}

export function parseResearchReport(text: string, workspacePath: string): ResearchReport {
  const value = extractJsonReport(text);
  const reportPath = typeof value === "object" && value !== null
    ? (value as { reportPath?: unknown }).reportPath
    : undefined;
  if (typeof reportPath === "string" && reportPath !== "report.md") {
    throw new ResearchError("unsafe_report_path", "unsafe_report_path: Only report.md may be published", 400);
  }
  const parsed = ResearchReportSchema.safeParse(value);
  if (!parsed.success) {
    throw new ResearchError("invalid_report", `invalid_report: ${parsed.error.issues[0]?.message ?? "Research report is invalid"}`, 422);
  }
  assertRegularFileInside(resolve(workspacePath, parsed.data.reportPath), workspacePath);
  return parsed.data;
}

export function buildPartialReport(text: string): string {
  const bytes = Buffer.from(text);
  let end = Math.min(bytes.length, 65_000);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  const bounded = bytes.subarray(0, end).toString("utf8");
  return [
    "# Partial research output",
    "",
    "Status: incomplete",
    "",
    "The research task did not publish a validated final report.",
    "",
    bounded,
    "",
  ].join("\n");
}
