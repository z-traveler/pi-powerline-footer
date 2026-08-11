import test from "node:test";
import assert from "node:assert/strict";
import * as footer from "../index.ts";
import * as segments from "../segments.ts";
import type { SegmentContext } from "../types.ts";

const originalNerdFonts = process.env.POWERLINE_NERD_FONTS;
process.env.POWERLINE_NERD_FONTS = "0";

test.after(() => {
  if (originalNerdFonts === undefined) {
    delete process.env.POWERLINE_NERD_FONTS;
  } else {
    process.env.POWERLINE_NERD_FONTS = originalNerdFonts;
  }
});

function createSegmentContext(agentName?: string): SegmentContext {
  return {
    model: undefined,
    thinkingLevel: "off",
    sessionId: undefined,
    agentName,
    cwd: "/tmp/project",
    usageStats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, subagentCost: 0 },
    contextTokens: 0,
    contextPercent: 0,
    contextWindow: 0,
    autoCompactEnabled: true,
    customCompactionEnabled: false,
    usingSubscription: false,
    queueSummary: { pending: 0, ideas: 0, blocked: 0, delivering: 0, failed: 0, total: 0, leadingText: null, leadingStatus: null, leadingIntent: null },
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
    theme: { fg: (_color, text) => text },
    colors: {},
  };
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

test("Given --agent leader metadata, the agent segment shows leader", () => {
  const findMainAgentName = Reflect.get(segments, "findMainAgentName") as ((entries: unknown[]) => string | undefined) | undefined;

  assert.equal(typeof findMainAgentName, "function");
  const agentName = findMainAgentName?.([
    { type: "custom", customType: "pi-subagents:main-agent", data: { name: "leader" } },
  ]);
  const rendered = segments.renderSegment("agent" as never, createSegmentContext(agentName));
  assert.equal(stripAnsi(rendered.content), "AG leader");
  assert.equal(rendered.visible, true);
});

test("Given no --agent metadata, the agent segment stays hidden", () => {
  assert.deepEqual(segments.renderSegment("agent" as never, createSegmentContext()), {
    content: "",
    visible: false,
  });
});

test("Given a 40-column footer, the agent segment ends at column 40", () => {
  const alignPowerlineContent = Reflect.get(footer, "alignPowerlineContent") as
    | ((left: string, right: string, width: number) => string)
    | undefined;

  assert.equal(typeof alignPowerlineContent, "function");
  const line = alignPowerlineContent?.(" left ", " AG leader ", 40) ?? "";
  assert.equal(line.length, 40);
  assert.equal(line.endsWith(" AG leader "), true);
});

test("Given agent is in layout.right, the rendered top bar pins it to the right edge", () => {
  const computeResponsiveLayout = Reflect.get(footer, "computeResponsiveLayout") as
    | ((ctx: SegmentContext, preset: unknown, width: number) => { topContent: string })
    | undefined;

  assert.equal(typeof computeResponsiveLayout, "function");
  const layout = computeResponsiveLayout?.(
    createSegmentContext("leader"),
    {
      leftSegments: ["path"],
      rightSegments: ["agent"],
      secondarySegments: [],
      separator: "none",
    },
    40,
  );
  const top = stripAnsi(layout?.topContent ?? "");
  assert.equal(top.length, 40);
  assert.equal(top.endsWith("AG leader "), true);
});
