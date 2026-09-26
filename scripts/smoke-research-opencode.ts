import { RESEARCH_PROTOCOL_VERSION } from "../src/research/contracts";
import { loadResearchConfig } from "../src/research/config";
import { runResearchLiveSmoke } from "../src/research/smoke";

if (process.argv.includes("--help")) {
  process.stdout.write("Usage: bun run smoke:research:opencode\n");
  process.exit(0);
}

const result = await runResearchLiveSmoke(loadResearchConfig());
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
