import { expect, test } from "bun:test";
import { runCommand, type CommandSpawnError } from "../src/process";

test("runCommand spawn errors carry the spawned pid so tree owners can clean up", () => {
  const command = process.platform === "win32" ? "ping" : "sleep";
  const args = process.platform === "win32" ? ["-n", "30", "127.0.0.1"] : ["30"];
  let error: CommandSpawnError | undefined;
  try {
    runCommand(command, args, { timeout: 300, killSignal: "SIGKILL" });
  } catch (caught) {
    error = caught as CommandSpawnError;
  }
  expect(error).toBeDefined();
  expect((error as NodeJS.ErrnoException | undefined)?.code).toBe("ETIMEDOUT");
  expect(typeof error?.pid).toBe("number");
  expect(error!.pid!).toBeGreaterThan(0);
}, 30_000);
