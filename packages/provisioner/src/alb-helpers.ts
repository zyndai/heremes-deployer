import {
  ElasticLoadBalancingV2Client,
  RegisterTargetsCommand,
  DeregisterTargetsCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2";

const HERMES_PORT = 8642;

export async function deregisterIp(
  client: ElasticLoadBalancingV2Client,
  targetGroupArn: string,
  ip: string,
): Promise<void> {
  await client.send(
    new DeregisterTargetsCommand({
      TargetGroupArn: targetGroupArn,
      Targets: [{ Id: ip, Port: HERMES_PORT }],
    }),
  );
}

export async function registerNewIp(
  client: ElasticLoadBalancingV2Client,
  targetGroupArn: string,
  ip: string,
): Promise<void> {
  await client.send(
    new RegisterTargetsCommand({
      TargetGroupArn: targetGroupArn,
      Targets: [{ Id: ip, Port: HERMES_PORT }],
    }),
  );
}
