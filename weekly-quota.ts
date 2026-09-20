export interface WeeklyQuota {
  remainingPercent: number;
  resetsAt: number | null;
}

type CodexModel = { id: string; provider?: string };
type ResolvedAuth = {
  ok: true;
  apiKey?: string;
  headers?: Record<string, string | null | undefined>;
} | {
  ok: false;
  error: string;
};
type ModelRegistryLike = {
  getApiKeyAndHeaders(model: CodexModel): Promise<ResolvedAuth>;
};
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const WEEK_TOLERANCE_SECONDS = 6 * 60 * 60;
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWindow(value: unknown): WeeklyQuota | null {
  if (!isRecord(value)) return null;
  const duration = value.limit_window_seconds;
  const used = value.used_percent;
  if (typeof duration !== "number" || !Number.isFinite(duration)
    || Math.abs(duration - WEEK_SECONDS) > WEEK_TOLERANCE_SECONDS
    || typeof used !== "number" || !Number.isFinite(used)) {
    return null;
  }

  const reset = value.reset_at;
  return {
    remainingPercent: Math.max(0, Math.min(100, 100 - used)),
    resetsAt: typeof reset === "number" && Number.isFinite(reset) ? reset : null,
  };
}

export function findWeeklyQuota(payload: unknown): WeeklyQuota | null {
  if (!isRecord(payload) || !isRecord(payload.rate_limit)) return null;
  return parseWindow(payload.rate_limit.primary_window)
    ?? parseWindow(payload.rate_limit.secondary_window);
}

function getHeader(headers: Record<string, string | null | undefined> | undefined, name: string): string | null {
  if (!headers) return null;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target && typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function extractAccountId(token: string): string | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const auth = isRecord(decoded) ? decoded[OPENAI_AUTH_CLAIM] : null;
    const accountId = isRecord(auth) ? auth.chatgpt_account_id : null;
    return typeof accountId === "string" && accountId.trim() ? accountId.trim() : null;
  } catch {
    return null;
  }
}

export async function fetchCodexWeeklyQuota(
  model: CodexModel | undefined,
  modelRegistry: ModelRegistryLike | undefined,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<WeeklyQuota | null> {
  if (model?.provider !== "openai-codex" || !modelRegistry) return null;

  try {
    const auth = await modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) return null;
    const headerToken = getHeader(auth.headers, "authorization")?.replace(/^Bearer\s+/i, "");
    const token = auth.apiKey ?? headerToken;
    if (!token) return null;
    const accountId = getHeader(auth.headers, "chatgpt-account-id") ?? extractAccountId(token);
    if (!accountId) return null;

    const response = await fetchImpl(CODEX_USAGE_URL, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "chatgpt-account-id": accountId,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    return findWeeklyQuota(await response.json());
  } catch {
    return null;
  }
}

export function formatQuotaReset(resetsAt: number | null, now = Date.now()): string | null {
  if (resetsAt === null) return null;
  const seconds = Math.max(0, resetsAt - now / 1000);
  if (seconds < 60) return "now";
  if (seconds < 60 * 60) return `${Math.ceil(seconds / 60)}m`;
  if (seconds < 24 * 60 * 60) return `${Math.ceil(seconds / (60 * 60))}h`;
  return `${Math.ceil(seconds / (24 * 60 * 60))}d`;
}
