// Client-side view of an agent (secrets already stripped by the API).
export interface AgentView {
  id: string;
  name: string;
  slug: string;
  status: string;
  hostUrl: string | null;
  personalityId?: string;
  personaLinked: boolean;
  createdAt: string;
}
