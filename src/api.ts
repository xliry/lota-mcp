const BASE_URL = process.env.LOTA_API_URL || "http://localhost:3000";
const SERVICE_KEY = process.env.LOTA_SERVICE_KEY || "";
const AGENT_ID = process.env.LOTA_AGENT_ID || "";

export async function lota(method: string, path: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (SERVICE_KEY) headers["x-service-key"] = SERVICE_KEY;
  if (AGENT_ID) headers["x-agent-id"] = AGENT_ID;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);

  try { return JSON.parse(text); } catch { return text; }
}

export function getAgentId(): string { return AGENT_ID; }
export function getBaseUrl(): string { return BASE_URL; }
