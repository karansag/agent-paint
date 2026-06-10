import test from "node:test";
import assert from "node:assert/strict";

import {
  createSvgElementExtractor,
  parseBatchElement,
  screenSvgElement,
} from "../lib/svg-stream.js";

function collect(chunks) {
  const elements = [];
  const extractor = createSvgElementExtractor((markup) => elements.push(markup));
  for (const chunk of chunks) extractor.push(chunk);
  extractor.flush();
  return elements;
}

test("emits a self-closing element split across chunks", () => {
  const elements = collect(['<circle cx="10', '" cy="5" r="3"/>']);
  assert.deepEqual(elements, ['<circle cx="10" cy="5" r="3"/>']);
});

test("emits nested groups as one element once the group closes", () => {
  const elements = collect([
    '<g fill="red"><rect x="1" y="2" width="3" height="4"/><circle cx="1" cy="1" r="1"/></g>',
  ]);
  assert.equal(elements.length, 1);
  assert.ok(elements[0].startsWith("<g"));
  assert.ok(elements[0].endsWith("</g>"));
});

test("preserves text content inside text elements", () => {
  const elements = collect(['<text x="5" y="9">hello world</text>']);
  assert.deepEqual(elements, ['<text x="5" y="9">hello world</text>']);
});

test("unwraps an svg wrapper into top-level children", () => {
  const elements = collect([
    '<svg viewBox="0 0 768 512"><rect x="0" y="0" width="10" height="10"/><circle cx="4" cy="4" r="2"/></svg>',
  ]);
  assert.equal(elements.length, 2);
  assert.ok(elements[0].startsWith("<rect"));
  assert.ok(elements[1].startsWith("<circle"));
});

test("ignores comments, prologs, markdown fences, and prose", () => {
  const elements = collect([
    "```xml\n",
    '<?xml version="1.0"?>\n',
    "<!-- thinking about composition -->\n",
    "Sure! Here is the drawing:\n",
    '<rect x="1" y="1" width="2" height="2"/>',
    "\n```",
  ]);
  assert.deepEqual(elements, ['<rect x="1" y="1" width="2" height="2"/>']);
});

test("handles a > inside a quoted attribute value", () => {
  const elements = collect(['<text x="1" y="1" data-note="a > b">ok</text>']);
  assert.equal(elements.length, 1);
  assert.ok(elements[0].includes("a > b"));
});

test("emits gradients with nested stops", () => {
  const elements = collect([
    '<defs><linearGradient id="sky"><stop offset="0" stop-color="#fff"/>',
    '<stop offset="1" stop-color="#00f"/></linearGradient></defs>',
  ]);
  assert.equal(elements.length, 1);
  assert.ok(elements[0].startsWith("<defs"));
  assert.ok(elements[0].endsWith("</defs>"));
});

test("parseBatchElement reads continue and note", () => {
  assert.deepEqual(parseBatchElement('<batch continue="true" note="add details"/>'), {
    continue: true,
    note: "add details",
  });
  assert.deepEqual(parseBatchElement("<batch continue='false' note='done'/>"), {
    continue: false,
    note: "done",
  });
  assert.equal(parseBatchElement('<rect x="1"/>'), null);
});

test("screenSvgElement rejects disallowed tags", () => {
  assert.equal(screenSvgElement("<script>alert(1)</script>").ok, false);
  assert.equal(screenSvgElement("<foreignObject><div/></foreignObject>").ok, false);
  assert.equal(screenSvgElement('<image href="https://x/y.png"/>').ok, false);
});

test("screenSvgElement strips event handlers and passes clean markup", () => {
  const screened = screenSvgElement('<rect x="1" onclick="alert(1)" width="2"/>');
  assert.equal(screened.ok, true);
  assert.ok(!screened.markup.includes("onclick"));

  const clean = screenSvgElement('<path d="M0 0 C 10 10, 20 10, 30 0" stroke="#123"/>');
  assert.equal(clean.ok, true);
  assert.equal(clean.markup, '<path d="M0 0 C 10 10, 20 10, 30 0" stroke="#123"/>');
});

test("screenSvgElement rejects javascript: URIs", () => {
  assert.equal(screenSvgElement('<use href="javascript:alert(1)"/>').ok, false);
});
