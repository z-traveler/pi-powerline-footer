import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface WeeklyQuota {
  remainingPercent: number;
  resetsAt: number | null;
}

export interface ClaudeQuota {
  fiveHour: WeeklyQuota | null;
  weekly: WeeklyQuota | null;
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
  isUsingOAuth?(model: CodexModel): boolean;
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

export function findClaudeQuota(payload: unknown): ClaudeQuota | null {
  if (!isRecord(payload)) return null;

  const parse = (value: unknown): WeeklyQuota | null => {
    if (!isRecord(value) || typeof value.utilization !== "number" || !Number.isFinite(value.utilization)) return null;
    const reset = typeof value.resets_at === "string" ? Date.parse(value.resets_at) / 1000 : NaN;
    return {
      remainingPercent: Math.max(0, Math.min(100, 100 - value.utilization)),
      resetsAt: Number.isFinite(reset) ? reset : null,
    };
  };
  const fiveHour = parse(payload.five_hour);
  const weekly = parse(payload.seven_day);
  return fiveHour || weekly ? { fiveHour, weekly } : null;
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

async function readClaudeCredentials(): Promise<string> {
  const configDir = process.env.PI_CLAUDE_CODE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return readFile(join(configDir, ".credentials.json"), "utf8");
}

export async function fetchClaudeQuota(
  model: CodexModel | undefined,
  modelRegistry: ModelRegistryLike | undefined,
  fetchImpl: FetchLike = globalThis.fetch,
  readCredentials: () => Promise<string> = readClaudeCredentials,
): Promise<ClaudeQuota | null> {
  if (model?.provider !== "claude-code" && model?.provider !== "anthropic") return null;

  try {
    let token: string | null | undefined;
    if (model.provider === "claude-code") {
      const credentials: unknown = JSON.parse(await readCredentials());
      const oauth = isRecord(credentials) ? credentials.claudeAiOauth : null;
      token = isRecord(oauth) && typeof oauth.accessToken === "string" ? oauth.accessToken : null;
    } else {
      if (!modelRegistry?.isUsingOAuth?.(model)) return null;
      const auth = await modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) return null;
      token = auth.apiKey ?? getHeader(auth.headers, "authorization")?.replace(/^Bearer\s+/i, "");
    }
    if (!token) return null;

    const response = await fetchImpl("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok ? findClaudeQuota(await response.json()) : null;
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
