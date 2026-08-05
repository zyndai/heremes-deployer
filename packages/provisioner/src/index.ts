// Excludes clients.ts so the web bundle never pulls in the AWS SDK; the CLI imports those directly.
export { provisionAgent, type ProvisionDeps } from "./provision";
export { teardownAgent, type TeardownDeps } from "./teardown";
export { loadConfig, loadLocalConfig, type Config } from "./config";
export { AgentStore } from "./store";
export { CHANNELS, LLM_PROVIDERS } from "./types";
export type { Channel, LlmProvider, ProvisionInput, AgentRecord } from "./types";
export { buildLocalProvisionDeps, buildLocalTeardownDeps, type LocalProvisionDeps, type LocalPorts } from "./local/local-deps";
export { updateAwsAgent, type UpdateInput, type UpdateResult } from "./update-aws";
export {
  DockerUnavailableError, PortUnavailableError, containerIsRunning,
  startContainer, stopContainer, restartContainer, containerLogs,
} from "./local/docker";
export { PERSONALITIES, PERSONALITY_IDS, getPersonality, type Personality } from "./presets";
