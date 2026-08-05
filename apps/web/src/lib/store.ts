import { AgentStore, type AgentRecord } from "@hermes/provisioner";
import { SupabaseAgentStore } from "@hermes/provisioner/supabase";
import { DynamoAgentStore } from "@hermes/provisioner/dynamo";
import { join } from "node:path";

export interface OwnedAgent extends AgentRecord {
  userId: string;
  name: string;
  channel: string;
}

// Backend priority: DynamoDB (HERMES_RUNTIME=aws) → Supabase (URL+key set) → JSON file (local dev).
const isAws = process.env.HERMES_RUNTIME === "aws";
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

const dynamo = isAws ? new DynamoAgentStore(process.env.AWS_REGION ?? "us-east-1") : null;
const supabase = !dynamo && supabaseUrl && supabaseKey ? new SupabaseAgentStore(supabaseUrl, supabaseKey) : null;

// Dev server runs from apps/web, so default two levels up to the repo root.
const STORE_PATH = process.env.HERMES_STORE_PATH ?? join(process.cwd(), "..", "..", ".agent-store.json");
const json = !dynamo && !supabase ? new AgentStore(STORE_PATH) : null;

function isOwned(r: AgentRecord): r is OwnedAgent {
  return typeof (r as OwnedAgent).userId === "string";
}

export async function listForUser(userId: string): Promise<OwnedAgent[]> {
  if (dynamo) return (await dynamo.listForUser(userId)) as OwnedAgent[];
  if (supabase) return (await supabase.listForUser(userId)) as OwnedAgent[];
  return json!.all().filter(isOwned).filter((r) => r.userId === userId);
}

export async function getOwned(userId: string, tenantId: string): Promise<OwnedAgent | undefined> {
  if (dynamo) return (await dynamo.getOwned(userId, tenantId)) as OwnedAgent | undefined;
  if (supabase) return (await supabase.getOwned(userId, tenantId)) as OwnedAgent | undefined;
  const r = json!.get(tenantId);
  return r && isOwned(r) && r.userId === userId ? r : undefined;
}

// Ownership already verified externally (e.g. via Postgres). Bypasses the
// userId check so stale DynamoDB userIds (old UUIDs vs new Google subs) don't
// block operations on records the caller has already confirmed they own.
export async function getByTenantId(tenantId: string): Promise<OwnedAgent | undefined> {
  if (dynamo) return (await dynamo.get(tenantId)) as OwnedAgent | undefined;
  if (supabase) return (await supabase.get(tenantId)) as OwnedAgent | undefined;
  const r = json!.get(tenantId);
  return r && isOwned(r) ? r : undefined;
}

export async function putOwned(record: OwnedAgent): Promise<void> {
  if (dynamo) return dynamo.put(record);
  if (supabase) return supabase.put(record);
  json!.put(record);
}

export async function deleteOwned(tenantId: string): Promise<void> {
  if (dynamo) return dynamo.delete(tenantId);
  if (supabase) return supabase.delete(tenantId);
  json!.delete(tenantId);
}
