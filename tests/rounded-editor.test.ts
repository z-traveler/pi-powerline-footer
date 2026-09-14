import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderFastPowerlineEditor, renderRoundedPowerlineEditorLines } from "../index.ts";

const identityBorder = (text: string) => text;

test("rounded editor embeds primary status in a full-width top border", () => {
  const rendered = renderRoundedPowerlineEditorLines(
    ["ignored upstream top border", "draft", "────────────"],
    " PI ",
    20,
    identityBorder,
  );

  assert.equal(rendered[0], "╭─ PI ─────────────╮");
  assert.equal(rendered[0]?.length, 20);
  assert.equal(rendered[1], "╰─ draft          ─╯");
  assert.equal(rendered[1]?.length, 20);
});

test("rounded editor preserves trailing auxiliary lines after the upstream border", () => {
  const rendered = renderRoundedPowerlineEditorLines(
    ["ignored upstream top border", "draft", "────────────", "completion"],
    "",
    20,
    identityBorder,
  );

  assert.deepEqual(rendered, [
    "╭──────────────────╮",
    "╰─ draft          ─╯",
    "completion",
  ]);
});

test("large drafts keep fast rendering and rounded overflow markers", () => {
  const editor = {
    state: {
      lines: Array.from({ length: 81 }, (_, index) => `draft ${index}`),
      cursorLine: 80,
      cursorCol: 8,
    },
    tui: { terminal: { rows: 24 } },
    focused: true,
    isShowingAutocomplete: () => false,
  };
  const fastLines = renderFastPowerlineEditor(editor, 34, {
    bashModeActive: false,
    completionsEnabled: false,
  });

  assert.ok(fastLines);
  const rendered = renderRoundedPowerlineEditorLines(fastLines, " PI ", 40, identityBorder);
  assert.equal(rendered[0]?.startsWith("╭↑ PI "), true);
  assert.equal(rendered.at(-1)?.startsWith("╰─"), true);
  assert.equal(rendered.every((line) => visibleWidth(line) === 40), true);
});
