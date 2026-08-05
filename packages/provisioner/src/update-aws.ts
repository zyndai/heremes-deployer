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
import { EC2Client } from "@aws-sdk/client-ec2";
import { ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { loadConfig, type Config } from "./config";
import { registerTaskDef } from "./taskdef";
import { waitForHealthy, resolveTaskPublicIp } from "./run";
import { deregisterIp, registerNewIp } from "./alb-helpers";

/**
 * Swap an ECS Fargate task in-place: stop the old task, start a new one
 * from an updated task definition (same config, new image), and reroute
 * the ALB to the new task's IP. The EFS access point is preserved — all
 * agent data (config, sessions, tokens) survives the swap.
 */
export interface UpdateInput {
  tenantId: string;
  targetImage: string;
  // Existing ECS plumbing — read from the DynamoDB agent record.
  taskArn: string;
  taskDefArn: string;
  accessPointId: string;
  securityGroupId: string;
  // ALB wiring — only set when the agent is behind an ALB.
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

  // --- 1. Find the current task's ENI IP before stopping it ---
  const oldIp = await resolveTaskPublicIp(ecs, ec2, cfg.cluster, input.taskArn).catch(
    () => "0.0.0.0",
  );

  // --- 2. Get the current task definition to copy its secret refs ---
  const td = await ecs.send(
    new DescribeTaskDefinitionCommand({ taskDefinition: input.taskDefArn }),
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
    accessPointId: input.accessPointId,
    secretRefs,
    imageOverride: input.targetImage,
  });

  console.log(`[update] registered new task def: ${newTdArn}`);

  // --- 4. Stop the old task ---
  await ecs.send(
    new StopTaskCommand({ cluster: cfg.cluster, task: input.taskArn, reason: "hermes update" }),
  );
  console.log(`[update] stopped old task: ${input.taskArn}`);

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
          securityGroups: [input.securityGroupId],
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
    await ecs.send(new DeregisterTaskDefinitionCommand({ taskDefinition: input.taskDefArn }));
    console.log(`[update] deregistered old task def: ${input.taskDefArn}`);
  } catch (e) {
    console.warn(`[update] could not deregister old task def: ${(e as Error).message}`);
  }

  return { taskArn: newTaskArn, taskDefArn: newTdArn, ip: newIp };
}
