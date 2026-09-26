import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

test("research documentation names setup, lifecycle, artifacts, recovery, and security limits", () => {
  const document = readFileSync(resolve(root, "docs/research-delegation.md"), "utf8");
  for (const exact of [
    "relego setup",
    "relego serve",
    "relego run",
    "relego submit",
    "timed_out",
    "interrupted",
    "partial_report",
    "detailed_report",
    "Idempotency-Key",
    "应用层权限控制，不是操作系统沙箱",
    "bun run smoke:opencode",
    "isolated temporary workspace and store",
    "wait=false",
    "wait=true",
  ]) {
    expect(document).toContain(exact);
  }
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  expect(packageJson.scripts["smoke:opencode"]).toBe("bun run scripts/smoke-opencode.ts");
  expect(readFileSync(resolve(root, "README.md"), "utf8")).toContain("docs/research-delegation.md");
  expect(readFileSync(resolve(root, "README.zh-CN.md"), "utf8")).toContain("docs/research-delegation.md");
});
