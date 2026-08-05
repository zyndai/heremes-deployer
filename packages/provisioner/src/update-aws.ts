import {
  ECSClient,
  ListTasksCommand,
  DescribeTasksCommand,
  DescribeTaskDefinitionCommand,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  StopTaskCommand,
  DeregisterTaskDefinitionCommand,
} from "@aws-sdk/client-ecs";
import { EC2Client, DescribeNetworkInterfacesCommand } from "@aws-sdk/client-ec2";
import { ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { loadConfig, type Config } from "./config";
import { registerTaskDef } from "./taskdef";
import { waitForHealthy, resolveTaskPublicIp } from "./run";
import { deregisterIp, registerNewIp } from "./alb-helpers";

/**
 * Find the running ECS task for an agent by family name (hermes-{tenantId}).
 * Extracts everything needed for an update from ECS directly — no DynamoDB
 * dependency. Returns null if no running task is found.
 */
export interface AgentTaskInfo {
  taskArn: string;
  taskDefArn: string;
  accessPointId: string;
  securityGroupId: string;
  targetGroupArn?: string;
  listenerRuleArn?: string;
}

export async function findAgentTask(tenantId: string): Promise<AgentTaskInfo | null> {
  const cfg = loadConfig();
  const ecs = new ECSClient({ region: cfg.region });
  const ec2 = new EC2Client({ region: cfg.region });

  const family = `hermes-${tenantId}`;

  // Find running tasks for this family.
  const tasks = await ecs.send(
    new ListTasksCommand({
      cluster: cfg.cluster,
      family,
      desiredStatus: "RUNNING",
    }),
  );

  const taskArns = tasks.taskArns ?? [];
  if (taskArns.length === 0) return null;
  const firstTaskArn = taskArns[0]!;

  // Describe the first running task.
  const described = await ecs.send(
    new DescribeTasksCommand({ cluster: cfg.cluster, tasks: [firstTaskArn] }),
  );
  const task = described.tasks?.[0];
  if (!task?.taskDefinitionArn) return null;

  // Get security group from the task's network config.
  const sgId = task.overrides?.containerOverrides?.[0]
    ? "" // fall through
    : "";
  const eniId = task.attachments
    ?.find((a) => a.type === "ElasticNetworkInterface")
    ?.details?.find((d) => d.name === "networkInterfaceId")?.value;

  let securityGroupId = "";
  if (eniId) {
    try {
      const eni = await ec2.send(
        new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: [eniId] }),
      );
      securityGroupId = eni.NetworkInterfaces?.[0]?.Groups?.[0]?.GroupId ?? "";
    } catch {
      // Non-fatal — the default SG will be used.
    }
  }

  // Describe the task definition to get the access point ID.
  const td = await ecs.send(
    new DescribeTaskDefinitionCommand({ taskDefinition: task.taskDefinitionArn }),
  );
  const volume = td.taskDefinition?.volumes?.find(
    (v) => v.name === "hermes-data",
  );
  const accessPointId =
    volume?.efsVolumeConfiguration?.authorizationConfig?.accessPointId ?? "";

  return {
    taskArn: firstTaskArn,
    taskDefArn: task.taskDefinitionArn!,
    accessPointId,
    securityGroupId,
  };
}

/**
 * Swap an ECS Fargate task in-place: stop the old task, start a new one
 * from an updated task definition (same config, new image), and reroute
 * the ALB to the new task's IP. The EFS access point is preserved — all
 * agent data (config, sessions, tokens) survives the swap.
 */
export interface UpdateInput {
  tenantId: string;
  targetImage: string;
  // These can be omitted — if missing, they'll be auto-discovered from ECS.
  taskArn?: string;
  taskDefArn?: string;
  accessPointId?: string;
  securityGroupId?: string;
  targetGroupArn?: string;
  listenerRuleArn?: string;
}

export interface UpdateResult {
  taskArn: string;
  taskDefArn: string;
  ip: string;
}

export async function updateAwsAgent(input: UpdateInput): Promise<UpdateResult> {
  const cfg = loadConfig();
  const ecs = new ECSClient({ region: cfg.region });
  const ec2 = new EC2Client({ region: cfg.region });
  const elb = new ElasticLoadBalancingV2Client({ region: cfg.region });

  // Auto-discover ECS task details when not provided (no DynamoDB record).
  let { taskArn, taskDefArn, accessPointId, securityGroupId } = input;
  if (!taskArn || !taskDefArn || !accessPointId || !securityGroupId) {
    const discovered = await findAgentTask(input.tenantId);
    if (!discovered) throw new Error(`No running ECS task found for agent ${input.tenantId}`);
    taskArn = taskArn ?? discovered.taskArn;
    taskDefArn = taskDefArn ?? discovered.taskDefArn;
    accessPointId = accessPointId ?? discovered.accessPointId;
    securityGroupId = securityGroupId ?? discovered.securityGroupId;
  }
  if (!taskArn || !taskDefArn) throw new Error("Cannot update: missing task ARN or task definition");
  if (!accessPointId) throw new Error("Cannot update: missing EFS access point ID");
  if (!securityGroupId) throw new Error("Cannot update: missing security group ID");

  // --- 1. Find the current task's ENI IP before stopping it ---
  const oldIp = await resolveTaskPublicIp(ecs, ec2, cfg.cluster, taskArn!).catch(
    () => "0.0.0.0",
  );

  // --- 2. Get the current task definition to copy its secret refs ---
  const td = await ecs.send(
    new DescribeTaskDefinitionCommand({ taskDefinition: taskDefArn! }),
  );
  const containerDef = td.taskDefinition?.containerDefinitions?.[0];
  if (!containerDef) throw new Error("Could not read task definition");

  // Build secret refs from the existing container definition
  const secretRefs =
    containerDef.secrets?.map((s) => ({
      name: s.name ?? "",
      valueFrom: s.valueFrom ?? "",
    })) ?? [];

  // --- 3. Register a NEW task definition with the updated image ---
  const newTdArn = await registerTaskDef(ecs, cfg, input.tenantId, {
    accessPointId: accessPointId!,
    secretRefs,
    imageOverride: input.targetImage,
  });

  console.log(`[update] registered new task def: ${newTdArn}`);

  // --- 4. Stop the old task ---
  await ecs.send(
    new StopTaskCommand({ cluster: cfg.cluster, task: taskArn!, reason: "hermes update" }),
  );
  console.log(`[update] stopped old task: ${taskArn}`);

  // --- 5. Start a new task with the new definition ---
  const runOut = await ecs.send(
    new RunTaskCommand({
      cluster: cfg.cluster,
      taskDefinition: newTdArn,
      launchType: "FARGATE",
      count: 1,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: cfg.subnetIds,
          securityGroups: [securityGroupId!],
          assignPublicIp: "ENABLED", // AWS public path (no ALB)
        },
      },
    }),
  );
  const newTaskArn = runOut.tasks?.[0]?.taskArn;
  if (!newTaskArn) throw new Error(`RunTask returned no task: ${JSON.stringify(runOut.failures)}`);

  console.log(`[update] started new task: ${newTaskArn}`);

  // --- 6. Wait for the new task to be healthy ---
  await waitForHealthy(ecs, cfg.cluster, newTaskArn);
  const newIp = await resolveTaskPublicIp(ecs, ec2, cfg.cluster, newTaskArn);

  console.log(`[update] new task healthy at IP: ${newIp}`);

  // --- 7. If using ALB, update the routing ---
  if (input.targetGroupArn && input.targetGroupArn !== "no-alb") {
    if (oldIp !== "0.0.0.0" && oldIp !== newIp) {
      await deregisterIp(elb, input.targetGroupArn, oldIp);
    }
    await registerNewIp(elb, input.targetGroupArn, newIp);
    console.log(`[update] ALB routing updated: ${oldIp} → ${newIp}`);
  }

  // --- 8. Deregister the OLD task definition ---
  try {
    await ecs.send(new DeregisterTaskDefinitionCommand({ taskDefinition: taskDefArn! }));
    console.log(`[update] deregistered old task def: ${taskDefArn}`);
  } catch (e) {
    console.warn(`[update] could not deregister old task def: ${(e as Error).message}`);
  }

  return { taskArn: newTaskArn, taskDefArn: newTdArn, ip: newIp };
}
