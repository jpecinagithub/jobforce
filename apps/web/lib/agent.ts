/**
 * Cliente del chat del Agente (aplicación directa por URL).
 */

export interface AgentMessage {
  id: string;
  jobId: string | null;
  role: 'user' | 'agent';
  content: string;
  createdAt: string;
}

export interface AgentJob {
  id: string;
  url: string;
  status: 'running' | 'done' | 'blocked' | 'failed';
  step: string | null;
  applicationId: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface AgentConversation {
  messages: AgentMessage[];
  jobs: AgentJob[];
  running: boolean;
}

export async function fetchConversation(): Promise<AgentConversation> {
  const res = await fetch('/api/agent/conversation');
  if (!res.ok) throw new Error(`El backend respondió ${res.status}`);
  return (await res.json()) as AgentConversation;
}

export async function sendAgentMessage(
  text: string,
  headers: Record<string, string>,
): Promise<{ ok: boolean; accepted: boolean; jobId?: string }> {
  const res = await fetch('/api/agent/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`El backend respondió ${res.status}`);
  return (await res.json()) as { ok: boolean; accepted: boolean; jobId?: string };
}
