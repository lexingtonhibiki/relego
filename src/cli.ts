import { stdout } from "node:process";
import { runResearchCli } from "./research/cli";
import { VERSION } from "./version";

const HELP = `research-gateway ${VERSION}

Local research delegation gateway backed by a local OpenCode executor.

Usage:
  research-gateway research setup --model provider/model [options]
  research-gateway research serve
  research-gateway research run REQUEST.json
  research-gateway research submit REQUEST.json
  research-gateway research status TASK_ID
  research-gateway research cancel TASK_ID
  research-gateway research doctor

Options:
  --home PATH   Override the configuration home directory
`;

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const home = takeOption(args, "--home");
  if (home) process.env.CODEX_CHATGPT_WEB_HOME = home;
  if (args[0] === "--help" || args[0] === "-h") {
    stdout.write(HELP);
    return;
  }
  if (args[0] === "--version" || args[0] === "-v") {
    stdout.write(`${VERSION}\n`);
    return;
  }
  const command = args.shift() ?? "help";
  if (command === "research") await runResearchCli(args);
  else throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}

main().catch(error => {
  process.stderr.write(`research-gateway: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
