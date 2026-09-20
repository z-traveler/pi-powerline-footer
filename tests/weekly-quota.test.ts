import test from "node:test";
import assert from "node:assert/strict";
import { fetchCodexWeeklyQuota, findWeeklyQuota, formatQuotaReset } from "../weekly-quota.ts";
import { renderSegment } from "../segments.ts";
import type { SegmentContext } from "../types.ts";

const WEEK_SECONDS = 7 * 24 * 60 * 60;

function fakeAccessToken(accountId = "acct-test"): string {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).toString("base64url");
  return `header.${payload}.signature`;
}

function createSegmentContext(overrides: Partial<SegmentContext> = {}): SegmentContext {
  return {
    model: { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai-codex", reasoning: true },
    thinkingLevel: "off",
    sessionId: undefined,
    agentName: undefined,
    cwd: "/tmp/project",
    usageStats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, subagentCost: 0 },
    contextTokens: 0,
    contextPercent: 0,
    contextWindow: 0,
    contextApproximate: false,
    autoCompactEnabled: true,
    customCompactionEnabled: false,
    usingSubscription: true,
    queueSummary: { queueCount: 0, blockedCount: 0, compacting: false, leadingText: null, leadingIntent: null, leadingStatus: null },
    sessionStartTime: Date.now(),
    shellModeActive: false,
    shellRunning: false,
    shellName: null,
    shellCwd: null,
    git: { branch: null, staged: 0, unstaged: 0, untracked: 0 },
    extensionStatuses: new Map(),
    hiddenExtensionStatusKeys: new Set(),
    customItemsById: new Map(),
    options: {},
    theme: { fg: (color, text) => `<${color}>${text}</${color}>` },
    colors: {},
    ...overrides,
  };
}

test("weekly quota is identified by its duration even when it is the primary window", () => {
  const quota = findWeeklyQuota({
    rate_limit: {
      primary_window: { used_percent: 17, limit_window_seconds: WEEK_SECONDS, reset_at: 1_800_000_000 },
      secondary_window: null,
    },
  });

  assert.deepEqual(quota, { remainingPercent: 83, resetsAt: 1_800_000_000 });
});

test("weekly quota skips a five-hour primary window and accepts a near-seven-day secondary window", () => {
  const quota = findWeeklyQuota({
    rate_limit: {
      primary_window: { used_percent: 40, limit_window_seconds: 18_000, reset_at: 1_700_000_000 },
      secondary_window: { used_percent: 76, limit_window_seconds: WEEK_SECONDS - 60, reset_at: 1_800_000_000 },
    },
  });

  assert.deepEqual(quota, { remainingPercent: 24, resetsAt: 1_800_000_000 });
});

test("Codex quota fetch is limited to openai-codex and scopes the request to the token account", async () => {
  let authCalls = 0;
  let requestedUrl = "";
  let requestedHeaders = new Headers();
  const registry = {
    async getApiKeyAndHeaders() {
      authCalls++;
      return { ok: true as const, apiKey: fakeAccessToken("acct-123") };
    },
  };
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({
      rate_limit: {
        primary_window: { used_percent: 11, limit_window_seconds: WEEK_SECONDS, reset_at: 1_800_000_000 },
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const quota = await fetchCodexWeeklyQuota(
    { id: "gpt-5.6-sol", provider: "openai-codex" },
    registry,
    fetchImpl,
  );
  const nonCodex = await fetchCodexWeeklyQuota(
    { id: "gpt-5.6", provider: "openai" },
    registry,
    fetchImpl,
  );

  assert.deepEqual(quota, { remainingPercent: 89, resetsAt: 1_800_000_000 });
  assert.equal(nonCodex, null);
  assert.equal(authCalls, 1);
  assert.equal(requestedUrl, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(requestedHeaders.get("authorization"), `Bearer ${fakeAccessToken("acct-123")}`);
  assert.equal(requestedHeaders.get("chatgpt-account-id"), "acct-123");
});

test("quota reset uses a compact countdown", () => {
  const now = 1_700_000_000_000;

  assert.equal(formatQuotaReset(now / 1000 + 45, now), "now");
  assert.equal(formatQuotaReset(now / 1000 + 20 * 60, now), "20m");
  assert.equal(formatQuotaReset(now / 1000 + 5 * 60 * 60, now), "5h");
  assert.equal(formatQuotaReset(now / 1000 + 6 * 24 * 60 * 60, now), "6d");
});

test("weekly quota colors remaining capacity and renders reset time in dim parentheses", () => {
  const now = Date.now();
  const resetsAt = Math.floor(now / 1000) + 6 * 24 * 60 * 60;
  const render = (remainingPercent: number) => renderSegment("weekly_quota", createSegmentContext({
    weeklyQuota: { remainingPercent, resetsAt },
  })).content;

  assert.equal(render(80), "<success>week:80%</success><dim> (6d)</dim>");
  assert.equal(render(24), "<warning>week:24%</warning><dim> (6d)</dim>");
  assert.equal(render(9), "<error>week:9%</error><dim> (6d)</dim>");
});

test("weekly quota stays hidden for non-Codex main models", () => {
  const rendered = renderSegment("weekly_quota", createSegmentContext({
    model: { id: "deepseek-chat", provider: "deepseek" },
    weeklyQuota: { remainingPercent: 80, resetsAt: Math.floor(Date.now() / 1000) + WEEK_SECONDS },
  }));

  assert.deepEqual(rendered, { content: "", visible: false });
});
