import test from "node:test";
import assert from "node:assert/strict";
import { fetchClaudeQuota, fetchCodexWeeklyQuota, findClaudeQuota, findWeeklyQuota, formatQuotaReset } from "../weekly-quota.ts";
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

test("Claude quota reports remaining five-hour and aggregate weekly capacity", () => {
  assert.deepEqual(findClaudeQuota({
    five_hour: { utilization: 12.5, resets_at: "2027-01-15T08:00:00Z" },
    seven_day: { utilization: 76, resets_at: "2027-01-20T08:00:00Z" },
    seven_day_sonnet: { utilization: 90, resets_at: "2027-01-20T08:00:00Z" },
  }), {
    fiveHour: { remainingPercent: 87.5, resetsAt: 1_800_000_000 },
    weekly: { remainingPercent: 24, resetsAt: 1_800_432_000 },
  });
});

test("Claude Code quota uses its existing local login without Pi auth or token refresh", async () => {
  let requestedUrl = "";
  let requestedHeaders = new Headers();
  const quota = await fetchClaudeQuota(
    { id: "claude-sonnet-5", provider: "claude-code" },
    undefined,
    async (input, init) => {
      requestedUrl = String(input);
      requestedHeaders = new Headers(init?.headers);
      assert.equal(init?.method, "GET");
      return Response.json({ five_hour: { utilization: 10, resets_at: null }, seven_day: { utilization: 20 } });
    },
    async () => JSON.stringify({ claudeAiOauth: { accessToken: "claude-code-test-token" } }),
  );

  assert.deepEqual(quota, {
    fiveHour: { remainingPercent: 90, resetsAt: null },
    weekly: { remainingPercent: 80, resetsAt: null },
  });
  assert.equal(requestedUrl, "https://api.anthropic.com/api/oauth/usage");
  assert.equal(requestedHeaders.get("authorization"), "Bearer claude-code-test-token");
  assert.equal(requestedHeaders.get("anthropic-beta"), "oauth-2025-04-20");
});

test("Claude quota omits missing or malformed windows instead of assuming full capacity", () => {
  for (const payload of [null, {}, { five_hour: null, seven_day: null }, { five_hour: { utilization: "10" } }]) {
    assert.equal(findClaudeQuota(payload), null);
  }
  assert.deepEqual(findClaudeQuota({
    five_hour: { utilization: 120, resets_at: "invalid" },
    seven_day: { utilization: NaN },
  }), { fiveHour: { remainingPercent: 0, resetsAt: null }, weekly: null });
  assert.deepEqual(findClaudeQuota({ seven_day: { utilization: 0 } }), {
    fiveHour: null, weekly: { remainingPercent: 100, resetsAt: null },
  });
});

test("Anthropic subscription quota uses Pi OAuth rather than the Claude Code account", async () => {
  const registry = {
    isUsingOAuth: () => true,
    async getApiKeyAndHeaders() {
      return { ok: true as const, headers: { Authorization: "Bearer pi-oauth-token" } };
    },
  };
  const quota = await fetchClaudeQuota(
    { id: "claude-sonnet-5", provider: "anthropic" },
    registry,
    async (_input, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer pi-oauth-token");
      return Response.json({ seven_day: { utilization: 15 } });
    },
    async () => { throw new Error("Must not read a different account's credentials"); },
  );
  assert.deepEqual(quota, { fiveHour: null, weekly: { remainingPercent: 85, resetsAt: null } });
});

test("API and gateway Claude models never request local subscription quota", async () => {
  let externalCalls = 0;
  const registry = {
    isUsingOAuth: () => false,
    async getApiKeyAndHeaders() { externalCalls++; return { ok: true as const, apiKey: "api-key" }; },
  };
  for (const provider of ["anthropic", "cmh", "cliproxy", "openai-codex"]) {
    assert.equal(await fetchClaudeQuota(
      { id: "claude-sonnet-5", provider },
      registry,
      async () => { externalCalls++; return Response.json({}); },
      async () => { externalCalls++; return "{}"; },
    ), null);
  }
  assert.equal(externalCalls, 0);
});

test("unavailable Claude credentials, network errors and rejected usage requests stay hidden", async () => {
  const model = { id: "claude-sonnet-5", provider: "claude-code" };
  const credentials = async () => JSON.stringify({ claudeAiOauth: { accessToken: "test-token" } });
  for (const readCredentials of [async () => { throw new Error("missing credentials"); }, async () => "bad json", async () => "{}"]) {
    assert.equal(await fetchClaudeQuota(model, undefined, async () => { throw new Error("Must not fetch"); }, readCredentials), null);
  }
  for (const fetchImpl of [
    async () => { throw new Error("proxy unavailable"); },
    async () => new Response("Unauthorized", { status: 401 }),
    async () => new Response("Rate limited", { status: 429 }),
    async () => new Response("Invalid JSON"),
  ]) {
    assert.equal(await fetchClaudeQuota(model, undefined, fetchImpl, credentials), null);
  }
});

test("quota reset uses a compact countdown", () => {
  const now = 1_700_000_000_000;

  assert.equal(formatQuotaReset(now / 1000 + 45, now), "now");
  assert.equal(formatQuotaReset(now / 1000 + 20 * 60, now), "20m");
  assert.equal(formatQuotaReset(now / 1000 + 5 * 60 * 60, now), "5h");
  assert.equal(formatQuotaReset(now / 1000 + 6 * 24 * 60 * 60, now), "6d");
});

test("model includes weekly quota with threshold colors and a dim reset countdown", () => {
  const now = Date.now();
  const resetsAt = Math.floor(now / 1000) + 6 * 24 * 60 * 60;
  const render = (remainingPercent: number) => renderSegment("model", createSegmentContext({
    weeklyQuota: { remainingPercent, resetsAt },
  })).content;

  assert.ok(render(80).endsWith("<success> week:80%</success><dim> (6d)</dim>"));
  assert.ok(render(24).endsWith("<warning> week:24%</warning><dim> (6d)</dim>"));
  assert.ok(render(9).endsWith("<error> week:9%</error><dim> (6d)</dim>"));
});

test("Claude subscription models show both remaining windows in the Codex quota style", () => {
  const now = Math.floor(Date.now() / 1000);
  for (const provider of ["claude-code", "anthropic"]) {
    const result = renderSegment("model", createSegmentContext({
      model: { id: "claude-sonnet-5", provider },
      claudeQuota: {
        fiveHour: { remainingPercent: 80, resetsAt: now + 2 * 60 * 60 },
        weekly: { remainingPercent: 24, resetsAt: now + 6 * 24 * 60 * 60 },
      },
    }));
    assert.ok(result.content.endsWith("<success> 5h:80%</success><dim> (2h)</dim><warning> week:24%</warning><dim> (6d)</dim>"));
  }
});

test("Claude quota thresholds match Codex, and other main models never show stale Claude quota", () => {
  const claudeQuota = { fiveHour: { remainingPercent: 9, resetsAt: null }, weekly: null };
  const claude = createSegmentContext({ model: { id: "claude-sonnet-5", provider: "claude-code" }, claudeQuota });
  assert.ok(renderSegment("model", claude).content.endsWith("<error> 5h:9%</error>"));
  for (const provider of ["cmh", "cliproxy", "openai-codex", "anthropic"]) {
    const content = renderSegment("model", createSegmentContext({
      model: { id: "claude-sonnet-5", provider }, claudeQuota, usingSubscription: false,
    })).content;
    assert.equal(content.includes("5h:"), false);
    assert.equal(content.includes("week:"), false);
  }
});

test("model omits weekly quota for non-Codex main models and the legacy segment stays hidden", () => {
  const context = createSegmentContext({
    model: { id: "deepseek-chat", provider: "deepseek" },
    weeklyQuota: { remainingPercent: 80, resetsAt: Math.floor(Date.now() / 1000) + WEEK_SECONDS },
  });

  assert.equal(renderSegment("model", context).content.includes("week:"), false);
  assert.deepEqual(renderSegment("weekly_quota", context), { content: "", visible: false });
});
