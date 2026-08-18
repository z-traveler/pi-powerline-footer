import test from "node:test";
import assert from "node:assert/strict";
import { renderRoundedPowerlineEditorLines } from "../index.ts";

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
