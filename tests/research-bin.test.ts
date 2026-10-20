import { expect, test } from "bun:test";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { VERSION } from "../src/version";

test.skipIf(process.platform === "win32")("linked package bin runs outside the checkout with Bun", () => {
  const root = mkdtempSync(join(tmpdir(), "relego-linked-bin-"));
  const packageRoot = join(root, "package");
  const outside = join(root, "outside");
  const runtimeBin = join(root, "runtime-bin");
  const install = join(root, "bun");
  const home = join(root, "home");
  const env = { HOME: home, BUN_INSTALL: install, PATH: runtimeBin };
  try {
    mkdirSync(packageRoot);
    mkdirSync(outside);
    mkdirSync(runtimeBin);
    mkdirSync(home);
    cpSync(resolve(import.meta.dir, "../src"), join(packageRoot, "src"), { recursive: true });
    copyFileSync(resolve(import.meta.dir, "../package.json"), join(packageRoot, "package.json"));
    symlinkSync(resolve(import.meta.dir, "../node_modules"), join(packageRoot, "node_modules"), "dir");
    symlinkSync(process.execPath, join(runtimeBin, "bun"));

    const linked = Bun.spawnSync([process.execPath, "link", "--offline", "--ignore-scripts"], {
      cwd: packageRoot,
      env,
    });
    expect(linked.exitCode).toBe(0);
    const executable = join(install, "bin", "relego");
    // Use the shell entry point, not `bun src/cli.ts`, which bypasses the shebang.
    const run = (...args: string[]) => Bun.spawnSync(["/bin/sh", "-c", 'exec "$@"', "sh", executable, ...args], {
      cwd: outside,
      env,
    });
    const help = run("--help");
    expect(help.exitCode).toBe(0);
    expect(help.stderr.toString()).toBe("");
    expect(help.stdout.toString()).toContain(`relego ${VERSION}`);
    expect(help.stdout.toString()).toContain("Usage:");

    const doctor = run("--home", join(root, "unconfigured"), "doctor");
    expect(doctor.exitCode).toBe(1);
    expect(doctor.stdout.toString()).toBe("");
    expect(doctor.stderr.toString()).toContain("Research configuration is missing:");
    expect(doctor.stderr.toString()).toContain("Run relego setup first.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
