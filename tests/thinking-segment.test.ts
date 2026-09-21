import test from "node:test";
import assert from "node:assert/strict";
import { FAST_MODE_STATUS_KEY, renderSegment } from "../segments.ts";
import { rainbow } from "../theme.ts";
import type { ColorScheme, SegmentContext, ThemeLike } from "../types.ts";

function hexAnsi(hex: `#${string}`): string {
  const value = hex.slice(1);
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function createSegmentContext(thinkingLevel: string, colors: ColorScheme): SegmentContext {
  return {
    model: undefined,
    thinkingLevel,
    sessionId: undefined,
    usageStats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, subagentCost: 0 },
    contextTokens: 0,
    contextPercent: 0,
    contextWindow: 0,
    contextApproximate: false,
    autoCompactEnabled: true,
    customCompactionEnabled: false,
    usingSubscription: false,
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
    theme: {
      fg() {
        throw new Error("unexpected theme color lookup in thinking segment test");
      },
    } satisfies ThemeLike,
    colors,
  };
}

test("thinking segment uses per-level colors for off through medium", () => {
  const colors: ColorScheme = {
    thinking: "#111111",
    thinkingMinimal: "#222222",
    thinkingLow: "#333333",
    thinkingMedium: "#444444",
  };

  const off = renderSegment("thinking", createSegmentContext("off", colors));
  const minimal = renderSegment("thinking", createSegmentContext("minimal", colors));
  const low = renderSegment("thinking", createSegmentContext("low", colors));
  const medium = renderSegment("thinking", createSegmentContext("medium", colors));

  assert.equal(off.content, `${hexAnsi("#111111")}thinking:off\x1b[0m`);
  assert.equal(minimal.content, `${hexAnsi("#222222")}thinking:min\x1b[0m`);
  assert.equal(low.content, `${hexAnsi("#333333")}thinking:low\x1b[0m`);
  assert.equal(medium.content, `${hexAnsi("#444444")}thinking:med\x1b[0m`);
});

test("thinking segment uses rainbow styling for high through max", () => {
  const colors: ColorScheme = { thinking: "#111111" };

  for (const level of ["high", "xhigh", "max"]) {
    const rendered = renderSegment("thinking", createSegmentContext(level, colors));
    assert.deepEqual(rendered, {
      content: rainbow(`thinking:${level}`),
      visible: true,
    });
  }
});

test("model appends Session Fast after the inline thinking level", () => {
  const context = createSegmentContext("low", { model: "#555555", thinkingLow: "#333333" });
  context.model = { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai-codex", reasoning: true };
  context.extensionStatuses = new Map([[FAST_MODE_STATUS_KEY, "fast"]]);
  context.options = { model: { showThinkingLevel: true } };

  assert.match(stripAnsi(renderSegment("model", context).content), /GPT-5\.6 Sol:low:fast$/);
});

test("model keeps its own color while inline thinking uses the level color", () => {
  const colors: ColorScheme = {
    model: "#555555",
    thinkingLow: "#333333",
  };
  const lowContext = createSegmentContext("low", colors);
  lowContext.model = { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai-codex", reasoning: true };
  lowContext.options = { model: { showThinkingLevel: true } };

  const low = renderSegment("model", lowContext).content;
  assert.ok(low.startsWith(hexAnsi("#555555")));
  assert.ok(low.endsWith(`\x1b[0m${hexAnsi("#333333")}:low\x1b[0m`));

  const xhighContext = createSegmentContext("xhigh", colors);
  xhighContext.model = { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai-codex", reasoning: true };
  xhighContext.options = { model: { showThinkingLevel: true } };

  const xhigh = renderSegment("model", xhighContext).content;
  assert.ok(xhigh.startsWith(hexAnsi("#555555")));
  assert.ok(xhigh.endsWith(`\x1b[0m${rainbow(":xhigh")}`));
});
