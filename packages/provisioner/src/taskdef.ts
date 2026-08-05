import {
  ECSClient,
  RegisterTaskDefinitionCommand,
  DeregisterTaskDefinitionCommand,
} from "@aws-sdk/client-ecs";
import type { Config } from "./config";
import type { SecretRef } from "./secrets";

const HERMES_PORT = 8642;
const DASHBOARD_PORT = 9119;
const HERMES_HOME = "/opt/data";
const VOLUME_NAME = "hermes-data";

export interface TaskDefInput {
  accessPointId: string;
  secretRefs: SecretRef[];
  /** Override the default hermesImage from config. Used for version updates. */
  imageOverride?: string;
}

export async function registerTaskDef(
  client: ECSClient,
  cfg: Config,
  tenantId: string,
  input: TaskDefInput,
): Promise<string> {
  const image = input.imageOverride ?? cfg.hermesImage;
  const out = await client.send(
    new RegisterTaskDefinitionCommand({
      family: `hermes-${tenantId}`,
      requiresCompatibilities: ["FARGATE"],
      networkMode: "awsvpc",
      cpu: "1024",
      memory: "2048",
      executionRoleArn: cfg.executionRoleArn,
      taskRoleArn: cfg.taskRoleArn,
      volumes: [
        {
          name: VOLUME_NAME,
          efsVolumeConfiguration: {
            fileSystemId: cfg.efsFilesystemId,
            transitEncryption: "ENABLED",
            authorizationConfig: { accessPointId: input.accessPointId, iam: "ENABLED" },
          },
        },
      ],
      containerDefinitions: [
        {
          name: "hermes",
          image,
          essential: true,
          // Runs as root so s6 cont-init can chown EFS and drop to UID 10000; do not set `user` or `readonlyRootFilesystem` — both break boot.
          // Headless gateway, not the interactive CLI which EOFs in a non-TTY task. On Fargate the dashboard (9119) may not serve even when the API (8642) is healthy — a known gap.
          command: ["gateway", "run"],
          portMappings: [
            { containerPort: HERMES_PORT, protocol: "tcp" },
            { containerPort: DASHBOARD_PORT, protocol: "tcp" },
          ],
          mountPoints: [{ sourceVolume: VOLUME_NAME, containerPath: HERMES_HOME }],
          environment: [
            { name: "API_SERVER_ENABLED", value: "true" },
            { name: "API_SERVER_HOST", value: "0.0.0.0" },
            // No HERMES_GATEWAY_BOOTSTRAP_STATE: it makes the s6 reconciler start a second gateway, racing the CMD starter and killing the dashboard + task on Fargate.
            // Must match the EFS access point POSIX uid or the gateway hits EACCES.
            { name: "HERMES_UID", value: "10000" },
            // HERMES_DASHBOARD_HOST=0.0.0.0 is required, else the dashboard binds localhost inside the container and is unreachable.
            { name: "HERMES_DASHBOARD", value: "1" },
            { name: "HERMES_DASHBOARD_HOST", value: "0.0.0.0" },
            { name: "HERMES_DASHBOARD_INSECURE", value: "1" },
            { name: "HERMES_DASHBOARD_TUI", value: "1" },
          ],
          secrets: input.secretRefs.map((r) => ({ name: r.name, valueFrom: r.valueFrom })),
          healthCheck: {
            command: ["CMD-SHELL", `curl -sf http://localhost:${HERMES_PORT}/health || exit 1`],
            interval: 15,
            timeout: 5,
            retries: 3,
            startPeriod: 60,
          },
          logConfiguration: {
            logDriver: "awslogs",
            options: {
              "awslogs-group": `/hermes/${tenantId}`,
              "awslogs-region": cfg.region,
              "awslogs-stream-prefix": "hermes",
              "awslogs-create-group": "true",
            },
          },
        },
      ],
    }),
  );
  const arn = out.taskDefinition?.taskDefinitionArn;
  if (!arn) throw new Error("Task definition registration returned no ARN");
  return arn;
}

export async function deregisterTaskDef(client: ECSClient, taskDefArn: string): Promise<void> {
  await client.send(new DeregisterTaskDefinitionCommand({ taskDefinition: taskDefArn }));
}
