import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeSessionTokenStats, SessionBranchCache, SessionTokenStatsCache } from "../token-stats.ts";

function makeUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0, costPerToken = 0.001) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cost: { total: (input + output + cacheRead + cacheWrite) * costPerToken },
  };
}

function assistantEvent(usage: ReturnType<typeof makeUsage>, stopReason: string = "stop") {
  return {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      usage,
      stopReason,
    },
  };
}

function userEvent() {
  return {
    type: "message",
    message: { role: "user", content: [{ type: "text", text: "hello" }] },
  };
}

function subagentToolResultEvent(costs: number[]) {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "subagent",
      details: { results: costs.map((cost) => ({ usage: { cost } })) },
    },
  };
}

function subagentSlashResultEvent(costs: number[]) {
  return {
    type: "custom_message",
    customType: "subagent-slash-result",
    details: { result: { details: { results: costs.map((cost) => ({ usage: { cost } })) } } },
  };
}

test("session branch cache reuses a leaf path and refreshes when the leaf changes", () => {
  const cache = new SessionBranchCache();
  let leafId = "leaf-1";
  let branch: unknown[] = [{ id: leafId, value: 1 }];
  let branchReads = 0;
  const provider = {
    getLeafId: () => leafId,
    getBranch: () => {
      branchReads += 1;
      return branch;
    },
  };

  assert.deepEqual(cache.get(null), []);

  const first = cache.get(provider);
  (branch[0] as { value: number }).value = 2;
  assert.equal(cache.get(provider), first);
  assert.equal((cache.get(provider)[0] as { value: number }).value, 2);
  assert.equal(branchReads, 1);

  leafId = "leaf-2";
  branch = [...branch, { id: leafId }];
  assert.equal(cache.get(provider), branch);
  assert.equal(branchReads, 2);

  cache.reset();
  cache.get(provider);
  assert.equal(branchReads, 3);
});

test("computeSessionTokenStats aggregates usage and tracks thinking level", () => {
  const events = [
    userEvent(),
    { type: "thinking_level_change", thinkingLevel: "high" },
    assistantEvent(makeUsage(10, 5)),
    assistantEvent(makeUsage(20, 7, 3, 2), "error"), // billed failure
    assistantEvent(makeUsage(30, 9, 4, 1), "aborted"), // billed abort
    assistantEvent(makeUsage(40, 11, 6, 2)),
  ];

  const stats = computeSessionTokenStats(events);

  assert.equal(stats.input, 100);
  assert.equal(stats.output, 32);
  assert.equal(stats.cacheRead, 13);
  assert.equal(stats.cacheWrite, 5);
  assert.ok(Math.abs(stats.cost - 0.150) < 1e-12);
  assert.equal(stats.lastAssistant, (events[5] as any).message);
  assert.equal(stats.thinkingLevelFromSession, "high");
});

test("computeSessionTokenStats sums subagent child run cost from tool results and slash results", () => {
  const events = [
    userEvent(),
    assistantEvent(makeUsage(10, 5)),
    subagentToolResultEvent([0.12, 0.34]),
    subagentSlashResultEvent([0.5]),
  ];

  const stats = computeSessionTokenStats(events);
  assert.ok(Math.abs(stats.subagentCost - 0.96) < 1e-12);
});

test("computeSessionTokenStats excludes Codex subscription children from billable subagent cost", () => {
  const events = [{
    type: "message",
    message: {
      role: "toolResult",
      toolName: "subagent",
      details: {
        results: [
          { model: "openai-codex/gpt-5.6-sol:high", usage: { cost: 0.42 } },
          { model: "cliproxy/deepseek-flash:max", usage: { cost: 0.58 } },
        ],
      },
    },
  }];

  const stats = computeSessionTokenStats(events);
  assert.equal(stats.subagentCost, 1);
  assert.equal(stats.billableSubagentCost, 0.58);
});

test("computeSessionTokenStats ignores assistant messages without tokens for lastAssistant", () => {
  const events = [
    assistantEvent(makeUsage(10, 5)),
    assistantEvent(makeUsage(0, 0)),
  ];

  const stats = computeSessionTokenStats(events);
  assert.equal(stats.lastAssistant, (events[0] as any).message);
});

test("cache reuses stats object while session is unchanged", () => {
  const cache = new SessionTokenStatsCache();
  const events = [userEvent(), assistantEvent(makeUsage(10, 5))];

  const first = cache.get(events);
  const second = cache.get(events);

  assert.equal(second, first);
});

test("cache recomputes when events are appended", () => {
  const cache = new SessionTokenStatsCache();
  const events = [assistantEvent(makeUsage(10, 5))];

  const first = cache.get(events);
  events.push(assistantEvent(makeUsage(20, 7)));
  const second = cache.get(events);

  assert.notEqual(second, first);
  assert.equal(second.input, 30);
  assert.equal(second.output, 12);
});

test("cache recomputes when the last event is updated in place (streaming)", () => {
  const cache = new SessionTokenStatsCache();
  const tail = assistantEvent(makeUsage(10, 5), "streaming");
  const events = [userEvent(), tail];

  const first = cache.get(events);
  assert.equal(first.output, 5);

  // Streaming updates the trailing assistant message in place: same event
  // count, same object references, fresh usage numbers.
  tail.message.usage = makeUsage(10, 42);
  tail.message.stopReason = "stop";

  const second = cache.get(events);
  assert.notEqual(second, first);
  assert.equal(second.output, 42);
  assert.equal(second.lastAssistant, tail.message);
});

test("cache recomputes when the last subagent result cost is updated in place", () => {
  const cache = new SessionTokenStatsCache();
  const tail = subagentToolResultEvent([0.1]);
  const events = [assistantEvent(makeUsage(10, 5)), tail];

  const first = cache.get(events);
  assert.equal(first.subagentCost, 0.1);

  tail.message.details.results = [{ usage: { cost: 0.3 } }];

  const second = cache.get(events);
  assert.notEqual(second, first);
  assert.equal(second.subagentCost, 0.3);
});

test("cache recomputes when the last event turns into an error in place", () => {
  const cache = new SessionTokenStatsCache();
  const tail = assistantEvent(makeUsage(10, 5));
  const events = [assistantEvent(makeUsage(1, 1)), tail];

  const first = cache.get(events);
  assert.equal(first.input, 11);
  assert.equal(first.lastAssistant, tail.message);

  tail.message.stopReason = "error";

  const second = cache.get(events);
  assert.notEqual(second, first);
  assert.equal(second.input, 11);
  assert.equal(second.lastAssistant, events[0].message);
});

test("cache recomputes when the last event is replaced with a same-sized list", () => {
  const cache = new SessionTokenStatsCache();
  const events = [userEvent(), assistantEvent(makeUsage(10, 5))];

  const first = cache.get(events);
  events[1] = assistantEvent(makeUsage(10, 5));
  const second = cache.get(events);

  assert.notEqual(second, first);
  assert.deepEqual(
    { input: second.input, output: second.output },
    { input: first.input, output: first.output },
  );
});

test("cache does not rescan for in-place changes to non-trailing events", () => {
  const cache = new SessionTokenStatsCache();
  const head = assistantEvent(makeUsage(10, 5));
  const events = [head, assistantEvent(makeUsage(20, 7))];

  const first = cache.get(events);

  // Historical events are treated as immutable; only the trailing event is
  // re-validated. This documents the cache's correctness boundary.
  head.message.usage = makeUsage(999, 999);
  const second = cache.get(events);

  assert.equal(second, first);
  assert.equal(second.input, 30);
});

test("reset forces recomputation", () => {
  const cache = new SessionTokenStatsCache();
  const events = [assistantEvent(makeUsage(10, 5))];

  const first = cache.get(events);
  cache.reset();
  const second = cache.get(events);

  assert.notEqual(second, first);
  assert.equal(second.input, first.input);
});

test("index.ts wires the token stats cache into buildSegmentContext", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf-8");
  assert.match(source, /import \{ SessionUsageCache \} from "\.\/token-stats\.ts";/);
  assert.match(source, /tokenStatsCache\.get\(ctx\.sessionManager\)/);
  assert.match(source, /tokenStatsCache\.reset\(\)/);
});

for (const stopReason of ["error", "aborted"]) {
  test(`billed ${stopReason} counts without replacing the last usable assistant`, () => {
    const usable = assistantEvent(makeUsage(10, 5));
    const failed = assistantEvent(makeUsage(20, 7, 3, 2), stopReason);
    const stats = computeSessionTokenStats([usable, failed]);
    assert.equal(stats.input, 30);
    assert.equal(stats.output, 12);
    assert.equal(stats.cost, 0.047);
    assert.equal(stats.lastAssistant, usable.message);
  });
}

function nativeToolEvent(usage = makeUsage(20, 7, 3, 2)) {
  return { type: "message", message: { role: "toolResult", toolName: "any-tool", isError: true, usage } };
}

for (const type of ["toolResult", "usage", "compaction", "branch_summary"]) {
  test(`${type} charges count without affecting assistant/context state and refresh at the tail`, () => {
    const usable = assistantEvent(makeUsage(10, 5));
    const usage = makeUsage(20, 7, 3, 2);
    const tail = type === "toolResult" ? nativeToolEvent(usage) : { type, usage };
    const events = [usable, tail];
    const cache = new SessionTokenStatsCache();
    const first = cache.get(events);
    assert.equal(first.input, 30);
    assert.equal(first.output, 12);
    assert.equal(first.cacheRead, 3);
    assert.equal(first.cacheWrite, 2);
    assert.equal(first.cost, 0.047);
    assert.equal(first.lastAssistant, usable.message);
    assert.deepEqual(first, computeSessionTokenStats(events));
    usage.output = 42;
    usage.cost.total = 0.25;
    const second = cache.get(events);
    assert.notEqual(second, first);
    assert.equal(second.output, 47);
    assert.equal(second.cost, 0.265);
    assert.deepEqual(second, computeSessionTokenStats(events));
  });
}

test("native tool usage wins over legacy details on the same result, including zero usage", () => {
  for (const usage of [makeUsage(10, 5), makeUsage(0, 0)]) {
    const native = subagentToolResultEvent([9]);
    Object.assign(native.message, { usage });
    const events = [native, subagentToolResultEvent([0.25]), subagentSlashResultEvent([0.5])];
    const cache = new SessionTokenStatsCache();
    const stats = cache.get(events);
    assert.equal(stats.cost, usage.cost.total);
    assert.equal(stats.subagentCost, 0.75);
    assert.deepEqual(stats, computeSessionTokenStats(events));
  }
});

test("malformed usage and legacy costs cannot poison totals", () => {
  const events: unknown[] = [null, [], { type: "usage", usage: null }];
  for (const bad of [NaN, Infinity, "5", undefined]) {
    events.push({ type: "usage", usage: { ...makeUsage(1, 2), input: bad } });
    events.push({ type: "compaction", usage: { ...makeUsage(1, 2), cost: { total: bad } } });
    events.push({ type: "message", message: { role: "toolResult", toolName: "subagent", details: { results: [{ usage: { cost: bad } }] } } });
  }
  const stats = computeSessionTokenStats(events);
  assert.equal(stats.input, 0);
  assert.equal(stats.cost, 0);
  assert.equal(stats.subagentCost, 0);
});

test("full ledger accounting stays separate from same-size branch navigation and idle charges", async () => {
  const { SessionUsageCache } = await import("../token-stats.ts");
  const cache = new SessionUsageCache();
  const a = assistantEvent(makeUsage(10, 5));
  const b = assistantEvent(makeUsage(20, 7));
  const high = { type: "thinking_level_change", thinkingLevel: "high" };
  const low = { type: "thinking_level_change", thinkingLevel: "low" };
  const ledger = [high, a, low, b, { type: "usage", usage: makeUsage(3, 1) }];
  let branch: unknown[] = [high, a];
  let leaf = "a";
  let reads = 0;
  const provider = {
    getLeafId: () => leaf,
    getBranch: () => branch,
    getEntries: () => { reads++; return ledger.slice(); },
  };
  const first = cache.get(provider);
  assert.equal(first.input, 33);
  assert.equal(first.lastAssistant, a.message);
  assert.equal(first.thinkingLevelFromSession, "high");
  for (let i = 0; i < 20; i++) cache.get(provider);
  assert.equal(reads, 1, "unchanged renders must not copy the ledger");
  branch = [low, b];
  leaf = "b";
  const second = cache.get(provider);
  assert.equal(second.input, first.input);
  assert.equal(second.lastAssistant, b.message);
  assert.equal(second.thinkingLevelFromSession, "low");
  ledger[4].usage.output = 8;
  assert.equal(cache.get(provider).output, 20);
  const idle = { type: "usage", usage: makeUsage(4, 2) };
  ledger.push(idle);
  leaf = "idle";
  assert.equal(cache.get(provider).input, 37);
  const direct = computeSessionTokenStats(ledger);
  const current = cache.get(provider);
  assert.equal(current.cost, direct.cost);
  assert.equal(current.output, direct.output);
  cache.reset();
  assert.equal(cache.get(provider).input, 37);
});

test("cache switches between legacy-only and native usage on the same tail", () => {
  const tail = subagentToolResultEvent([0.5]);
  const events = [tail];
  const cache = new SessionTokenStatsCache();
  assert.equal(cache.get(events).subagentCost, 0.5);
  Object.assign(tail.message, { usage: makeUsage(10, 5) });
  const native = cache.get(events);
  assert.equal(native.subagentCost, 0);
  assert.equal(native.cost, 0.015);
  assert.deepEqual(native, computeSessionTokenStats(events));
  delete (tail.message as any).usage;
  const legacy = cache.get(events);
  assert.equal(legacy.subagentCost, 0.5);
  assert.equal(legacy.cost, 0);
  assert.deepEqual(legacy, computeSessionTokenStats(events));
});

test("full ledger cache does not rescan historical usage on unchanged renders", async () => {
  const { SessionUsageCache } = await import("../token-stats.ts");
  const cache = new SessionUsageCache();
  let historicalReads = 0;
  const head = assistantEvent(makeUsage(10, 5));
  const usage = head.message.usage;
  Object.defineProperty(head.message, "usage", { get: () => { historicalReads++; return usage; } });
  const entries = [head, nativeToolEvent()];
  const provider = { getLeafId: () => "tail", getBranch: () => entries, getEntries: () => entries.slice() };
  assert.equal(cache.get(provider).input, 30);
  assert.ok(historicalReads > 0);
  const reads = historicalReads;
  for (let i = 0; i < 20; i++) cache.get(provider);
  assert.equal(historicalReads, reads);
});

test("ledger count catches appends followed by a return to the cached leaf", async () => {
  const { SessionUsageCache } = await import("../token-stats.ts");
  const cache = new SessionUsageCache();
  const entries: unknown[] = [userEvent()];
  const provider = {
    getLeafId: () => "root",
    getBranch: () => [entries[0]],
    getEntries: () => entries.slice(),
    getEntryCount: () => entries.length,
  };
  assert.equal(cache.get(provider).cost, 0);
  entries.push({ type: "usage", usage: makeUsage(2_000, 0) });
  assert.equal(provider.getLeafId(), "root");
  assert.equal(cache.get(provider).cost, 2);
});

test("tree navigation resets snapshots on SDKs without a ledger count", async () => {
  const { SessionUsageCache } = await import("../token-stats.ts");
  const cache = new SessionUsageCache();
  const entries: unknown[] = [userEvent()];
  const provider = {
    getLeafId: () => "root",
    getBranch: () => [entries[0]],
    getEntries: () => entries.slice(),
  };
  assert.equal(cache.get(provider).cost, 0);
  entries.push({ type: "usage", usage: makeUsage(2_000, 0) });
  cache.reset();
  assert.equal(cache.get(provider).cost, 2);
});

test("malformed metadata is safe in cached as well as direct accounting", () => {
  const entries = [{ type: Symbol("bad") }, { type: "message", message: { role: Symbol("bad"), stopReason: {} } }];
  assert.deepEqual(new SessionTokenStatsCache().get(entries), computeSessionTokenStats(entries));
});

test("native subagent usage preserves billable classification and updates the cached tail", () => {
  const tail = {
    type: "message", message: {
      role: "toolResult", toolName: "subagent", usage: makeUsage(1000, 0),
      details: { results: [
        { model: "openai-codex/gpt", usage: { cost: 0.42 } },
        { model: "anthropic/claude", usage: { cost: 0.58 } },
      ] },
    },
  };
  const events = [tail];
  const cache = new SessionTokenStatsCache();
  const first = cache.get(events);
  assert.equal(first.cost, 1);
  assert.equal(first.subagentCost, 0);
  assert.equal(first.nativeSubagentCost, 1);
  assert.equal(first.billableSubagentCost, 0.58);
  assert.deepEqual(first, computeSessionTokenStats(events));
  tail.message.details.results[0]!.model = "anthropic/gpt";
  tail.message.details.results[1]!.model = "openai-codex/claude";
  const second = cache.get(events);
  assert.notEqual(second, first);
  assert.equal(second.billableSubagentCost, 0.42);
  assert.deepEqual(second, computeSessionTokenStats(events));
  tail.message.usage.cost.total = 0;
  assert.equal(cache.get(events).billableSubagentCost, 0);
});

test("native residual attribution refreshes after partial child details change in place", () => {
  const tail = { type: "message", message: {
    role: "toolResult", toolName: "subagent", usage: makeUsage(1000, 0),
    details: { results: [{ model: "openai-codex/gpt", usage: { cost: 0.42 } }] },
  } };
  const events = [tail];
  const cache = new SessionTokenStatsCache();
  const first = cache.get(events);
  assert.ok(Math.abs(first.billableSubagentCost - 0.58) < 1e-12);
  tail.message.details.results[0]!.usage.cost = 0.25;
  const second = cache.get(events);
  assert.notEqual(second, first);
  assert.equal(second.billableSubagentCost, 0.75);
  assert.deepEqual(second, computeSessionTokenStats(events));
});
