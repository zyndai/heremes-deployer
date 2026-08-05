import {
  provisionAgent,
  teardownAgent,
  updateAwsAgent,
  buildLocalProvisionDeps,
  buildLocalTeardownDeps,
  loadLocalConfig,
  loadConfig,
  containerIsRunning,
  startContainer,
  stopContainer,
  restartContainer,
  containerLogs,
  type ProvisionInput,
  type UpdateInput,
  type UpdateResult,
} from "@hermes/provisioner";
import { buildAwsPublicProvisionDeps, buildAwsPublicTeardownDeps } from "@hermes/provisioner/aws";
import type { CreateAgentBody } from "./validation";
import { putOwned, getOwned, getByTenantId, deleteOwned, listForUser, type OwnedAgent } from "./store";

const RUNTIME = process.env.HERMES_RUNTIME === "aws" ? "aws" : "local";
const IS_AWS = RUNTIME === "aws";

// Lets routes map missing/unowned tenants to 404 while genuine failures surface as 500.
export class AgentNotFoundError extends Error {
  constructor() {
    super("not found");
    this.name = "AgentNotFoundError";
  }
}

function tenantIdFor(userId: string, name: string): string {
  return `${userId}-${name}`;
}

function containerName(tenantId: string): string {
  return `hermes-${tenantId}`;
}

export async function createAgent(userId: string, body: CreateAgentBody): Promise<OwnedAgent> {
  const tenantId = tenantIdFor(userId, body.name);
  const input: ProvisionInput = {
    tenantId,
    channel: "web",
    llmProvider: "openrouter",
    llmKey: body.llmKey,
  };

  if (IS_AWS) {
    const cfg = loadConfig();
    const record = await provisionAgent(cfg, input, buildAwsPublicProvisionDeps(cfg));
    const owned: OwnedAgent = { ...record, userId, name: body.name, channel: "web" };
    await putOwned(owned);
    return owned;
  }

  const cfg = loadLocalConfig();
  const deps = buildLocalProvisionDeps(cfg, tenantId);
  const record = await provisionAgent(cfg, input, deps);
  // Persist the real host ports the container got so status/liveness/teardown target them.
  const ports = deps.resolvedPorts();
  const owned: OwnedAgent = {
    ...record,
    userId,
    name: body.name,
    channel: "web",
    ...(ports ? { apiPort: ports.apiPort, dashboardPort: ports.dashboardPort } : {}),
  };
  await putOwned(owned);
  return owned;
}

type AgentAction = "start" | "stop" | "restart";

export async function controlAgent(
  userId: string,
  tenantId: string,
  action: AgentAction,
): Promise<OwnedAgent> {
  const record = await getOwned(userId, tenantId);
  if (!record) throw new AgentNotFoundError();
  if (IS_AWS) throw new Error("start/stop/restart are not supported on the AWS runtime yet");
  const name = containerName(tenantId);
  if (action === "start") await startContainer(name);
  else if (action === "stop") await stopContainer(name);
  else await restartContainer(name);
  const alive = await containerIsRunning(name);
  const updated: OwnedAgent = { ...record, status: alive ? "running" : "stopped" };
  await putOwned(updated);
  return updated;
}

export async function agentLogs(userId: string, tenantId: string): Promise<string> {
  const record = await getOwned(userId, tenantId);
  if (!record) throw new AgentNotFoundError();
  if (IS_AWS) return "(logs are in CloudWatch /hermes/agents for the AWS runtime)";
  return containerLogs(containerName(tenantId));
}

export async function removeAgent(userId: string, tenantId: string): Promise<void> {
  const record = await getOwned(userId, tenantId);
  if (!record) throw new AgentNotFoundError();
  // Tear down the runtime before dropping the record: if teardown throws, the
  // record is kept so the agent stays manageable instead of becoming an orphan.
  if (IS_AWS) {
    const cfg = loadConfig();
    await teardownAgent(record, buildAwsPublicTeardownDeps(cfg), { deleteData: true });
  } else {
    await teardownAgent(record, buildLocalTeardownDeps(tenantId), { deleteData: true });
  }
  await deleteOwned(tenantId);
}

// Re-check the container before trusting a stored "running" status, since it can
// exit (crash, OOM, sleep) long after provisioning and leave the record stale.
async function withLiveStatus(agent: OwnedAgent): Promise<OwnedAgent> {
  if (agent.status !== "running") return agent;
  // AWS liveness via ECS DescribeTasks is a later step; trust stored status for now.
  if (IS_AWS) return agent;
  const alive = await containerIsRunning(containerName(agent.tenantId));
  return alive ? agent : { ...agent, status: "stopped" };
}

export async function getAgent(userId: string, tenantId: string): Promise<OwnedAgent | undefined> {
  const agent = await getOwned(userId, tenantId);
  return agent ? withLiveStatus(agent) : undefined;
}

export async function updateAgentVersion(
  userId: string,
  tenantId: string,
  targetImage: string,
): Promise<UpdateResult> {
  if (!IS_AWS) throw new Error("updateAgentVersion is only available on the AWS runtime");

  // Find the running ECS task directly (no DynamoDB dependency). The task
  // family is hermes-{tenantId} — discover taskArn, taskDefArn, accessPointId,
  // and security group from ECS/EC2 APIs.
  const input: UpdateInput = { tenantId, targetImage };

  const result = await updateAwsAgent(input);

  // Try to update the DynamoDB record if it exists (best-effort).
  try {
    const record = await getByTenantId(tenantId);
    if (record) {
      const updated: OwnedAgent = {
        ...record,
        status: "running",
        taskArn: result.taskArn,
        taskDefArn: result.taskDefArn,
      };
      await putOwned(updated);
    }
  } catch {
    // DynamoDB record may not exist — that's fine, the update succeeded.
  }

  return result;
}

export async function listAgents(userId: string): Promise<OwnedAgent[]> {
  return Promise.all((await listForUser(userId)).map(withLiveStatus));
}
