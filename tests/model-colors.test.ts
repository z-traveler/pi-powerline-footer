import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderSegment } from "../segments.ts";
import type { SegmentContext } from "../types.ts";

const originalNerdFonts = process.env.POWERLINE_NERD_FONTS;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.POWERLINE_NERD_FONTS = "0";
const agentDirs: string[] = [];

test.after(() => {
  if (originalNerdFonts === undefined) delete process.env.POWERLINE_NERD_FONTS;
  else process.env.POWERLINE_NERD_FONTS = originalNerdFonts;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  for (const dir of agentDirs) rmSync(dir, { recursive: true, force: true });
});

// Points the footer at a fresh agent dir whose extensions/powerline-footer/theme.json holds `theme`.
// A new directory per test also gives theme.ts a new cache key, so tests never see each other's file.
function useThemeJson(theme?: unknown): void {
  const agentDir = mkdtempSync(join(tmpdir(), "powerline-model-colors-"));
  agentDirs.push(agentDir);
  if (theme !== undefined) {
    const extensionDir = join(agentDir, "extensions", "powerline-footer");
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(join(extensionDir, "theme.json"), typeof theme === "string" ? theme : JSON.stringify(theme));
  }
  process.env.PI_CODING_AGENT_DIR = agentDir;
}

function hexAnsi(hex: `#${string}`): string {
  const value = hex.slice(1);
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

const DEFAULT_MODEL_COLOR = "#d787af";

function renderModel(model: SegmentContext["model"], overrides: Partial<SegmentContext> = {}): string {
  const ctx: SegmentContext = {
    model,
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
    usingSubscription: false,
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
    colors: { model: DEFAULT_MODEL_COLOR },
    ...overrides,
  };
  return renderSegment("model", ctx).content;
}

// Model ids and display names are matched before display formatting.
const DEEPSEEK = { id: "deepseek-flash", name: "DeepSeek Flash", provider: "cmh" };
const GPT = { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", provider: "cliproxy" };
const CLAUDE = { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "cmh" };
const KIMI = { id: "kimi-k3.1-pro-highspeed", name: "Kimi K3.1 Pro Highspeed", provider: "cliproxy" };

test("pattern rules in theme.json color each model family; other models keep the default model color", () => {
  useThemeJson({
    modelColors: [
      { pattern: "deepseek", color: "#6e9bc5" },
      { pattern: "gpt", color: "#f5f5f5" },
      { pattern: "claude", color: "#fac03d" },
    ],
  });

  assert.equal(renderModel(DEEPSEEK), `${hexAnsi("#6e9bc5")}DeepSeek Flash\x1b[0m`);
  assert.equal(renderModel(GPT), `${hexAnsi("#f5f5f5")}GPT-6.1 Sol\x1b[0m`);
  assert.equal(renderModel(CLAUDE), `${hexAnsi("#fac03d")}Sonnet 5.5\x1b[0m`);
  assert.equal(renderModel(KIMI), `${hexAnsi(DEFAULT_MODEL_COLOR)}Kimi K3.1 Pro Highspeed\x1b[0m`);
});

test("exact model names, ids and provider/id are supported, with first match winning", () => {
  useThemeJson({ modelColors: [
    { model: "Claude Sonnet 5.5", color: "success" },
    { pattern: "claude", color: "warning" },
    { model: "cliproxy/gpt-6.1-sol", color: "accent" },
    { model: "deepseek-flash", color: "text" },
  ] });
  assert.equal(renderModel(CLAUDE), "<success>Sonnet 5.5</success>");
  assert.equal(renderModel(GPT), "<accent>GPT-6.1 Sol</accent>");
  assert.equal(renderModel(DEEPSEEK), "<text>DeepSeek Flash</text>");
  assert.equal(renderModel({ ...GPT, provider: "other" }), `${hexAnsi(DEFAULT_MODEL_COLOR)}GPT-6.1 Sol\x1b[0m`);
});

test("regex syntax works and malformed rules are ignored", () => {
  useThemeJson({ modelColors: [
    null, { pattern: "[", color: "error" }, { pattern: "gpt", color: 123 },
    { pattern: "^GPT-6\\.1-(sol|terra)$", color: "success" },
  ] });
  assert.equal(renderModel(GPT), "<success>GPT-6.1 Sol</success>");
  assert.equal(renderModel(KIMI), `${hexAnsi(DEFAULT_MODEL_COLOR)}Kimi K3.1 Pro Highspeed\x1b[0m`);
});

test("missing rules retain theme.json model color and suffix colors remain independent", () => {
  useThemeJson({ colors: { model: "accent" } });
  assert.equal(renderModel(GPT), "<accent>GPT-6.1 Sol</accent>");
  useThemeJson({ modelColors: [{ pattern: "gpt", color: "success" }] });
  assert.equal(renderModel({ ...GPT, reasoning: true }, {
    thinkingLevel: "low", colors: { thinkingLow: "warning" },
  }), "<success>GPT-6.1 Sol</success><warning>:low</warning>");
  useThemeJson({ modelColors: "invalid" });
  assert.equal(renderModel(undefined), `${hexAnsi(DEFAULT_MODEL_COLOR)}no-model\x1b[0m`);
});
