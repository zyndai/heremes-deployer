export interface ConnectTokenRecord {
  token: string;
  tenantId: string;
  // epoch ms after which the token is invalid
  expiresAt: number;
  createdAt: number;
}

export interface ChatLink {
  chatId: number;
  tenantId: string;
  who?: string;
  linkedAt: string;
}

export interface AgentEndpoint {
  baseUrl: string;
  apiKey: string; // API_SERVER_KEY (Bearer)
  // ZYND memory-layer credentials, present only for persona-linked agents. Read
  // from the container env (ZYND_MEMORY_TOKEN / ZYND_MEMORY_URL). When set, the
  // gateway tees each user turn into the owner's ZYND memory.
  zyndToken?: string;
  zyndUrl?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  text?: string;
  chat: { id: number; type?: string };
  from?: { id: number; username?: string; first_name?: string };
}
