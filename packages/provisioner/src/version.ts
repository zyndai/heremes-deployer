import {
  ECSClient,
  DescribeTasksCommand,
  DescribeTaskDefinitionCommand,
} from "@aws-sdk/client-ecs";
import { DynamoAgentStore } from "./dynamo-store";

/**
 * Resolve the actual Hermes version running on an agent by inspecting its
 * ECS task definition's Docker image tag. Used to backfill the version for
 * agents deployed before version tracking was added.
 */
export async function resolveAgentVersion(
  tenantId: string,
  opts?: { region?: string; cluster?: string },
): Promise<string | null> {
  const region = opts?.region ?? process.env.AWS_REGION ?? "us-east-1";
  const cluster = opts?.cluster ?? process.env.ECS_CLUSTER ?? "hermes-cluster";

  const ecs = new ECSClient({ region });
  const store = new DynamoAgentStore(region);

  // Read the agent record from DynamoDB to get the task ARN.
  const record = await store.get(tenantId);
  if (!record?.taskArn) return null;

  // Describe the task to get the task definition ARN.
  const tasks = await ecs.send(
    new DescribeTasksCommand({ cluster, tasks: [record.taskArn] }),
  );
  const taskDefArn = tasks.tasks?.[0]?.taskDefinitionArn;
  if (!taskDefArn) return null;

  // Describe the task definition to get the image.
  const td = await ecs.send(
    new DescribeTaskDefinitionCommand({ taskDefinition: taskDefArn }),
  );
  const image = td.taskDefinition?.containerDefinitions?.[0]?.image;
  if (!image) return null;

  // Extract the version from the image tag (everything after ":").
  const tag = image.includes(":") ? image.split(":").pop()! : null;
  if (!tag) return null;

  // Normalise: GitHub tags start with "v", image tags may not.
  // Accept any tag including "latest" — it's better than "Unknown".
  return tag.startsWith("v") ? tag : `v${tag}`;
}
