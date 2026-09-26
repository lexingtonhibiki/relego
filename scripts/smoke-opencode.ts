import { RESEARCH_PROTOCOL_VERSION } from "../src/contracts";
import { loadResearchConfig } from "../src/config";
import { runResearchLiveSmoke } from "../src/smoke";

if (process.argv.includes("--help")) {
  process.stdout.write("Usage: bun run smoke:research:opencode\n");
  process.exit(0);
}

const result = await runResearchLiveSmoke(loadResearchConfig());
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
