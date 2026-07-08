import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AgentStore, type AgentRecord } from "@hermes/provisioner";
import type { AgentEndpoint } from "./types";

const pexecFile = promisify(execFile);

export interface AgentResolver {
  resolve(tenantId: string): Promise<AgentEndpoint | null>;
}

// API key read live via `docker inspect` so no raw secret is persisted to the store.
export class LocalAgentResolver implements AgentResolver {
  constructor(
    private readonly store: AgentStore,
    private readonly readEnv: (container: string, name: string) => Promise<string | null> = dockerEnv,
  ) {}

  async resolve(tenantId: string): Promise<AgentEndpoint | null> {
    const rec = this.store.get(tenantId) as (AgentRecord & { apiPort?: number }) | undefined;
    if (!rec || typeof rec.apiPort !== "number") return null;
    if (rec.status !== "running") return null;
    const apiKey = await this.readEnv(`hermes-${tenantId}`, "API_SERVER_KEY");
    if (!apiKey) return null;
    return { baseUrl: `http://localhost:${rec.apiPort}`, apiKey };
  }
}

async function dockerEnv(container: string, name: string): Promise<string | null> {
  try {
    const { stdout } = await pexecFile("docker", [
      "inspect",
      "--format",
      "{{range .Config.Env}}{{println .}}{{end}}",
      container,
    ]);
    for (const line of stdout.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0 && line.slice(0, eq) === name) return line.slice(eq + 1);
    }
    return null;
  } catch {
    return null;
  }
}
