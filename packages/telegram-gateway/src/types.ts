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
