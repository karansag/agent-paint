// Incremental extractor for SVG elements arriving over a token stream.
//
// The model streams raw SVG markup (no JSON wrapper). This parser consumes
// arbitrary chunk boundaries and emits each complete top-level element as a
// string the moment its closing tag arrives, so the browser can paint
// progressively. An <svg> wrapper, comments, XML prologs, markdown fences,
// and prose between elements are all ignored.

const MAX_ELEMENT_CHARS = 20000;
const MAX_PENDING_CHARS = 40000;

export const SVG_ELEMENT_TAGS = new Set([
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "g",
  "defs",
  "use",
  "symbol",
  "linearGradient",
  "radialGradient",
  "stop",
  "title",
  "desc",
]);

export const CONTROL_TAG = "batch";

export function createSvgElementExtractor(onElement) {
  let pending = "";
  let element = "";
  let stack = [];

  function resetElement() {
    element = "";
    stack = [];
  }

  function emit() {
    const markup = element.trim();
    resetElement();
    if (markup) onElement(markup);
  }

  function handleTag(rawTag) {
    const nameMatch = rawTag.match(/^<\/?\s*([A-Za-z][\w:.-]*)/);
    if (!nameMatch) return;
    const name = nameMatch[1];
    const isClosing = rawTag[1] === "/";
    const isSelfClosing = /\/\s*>$/.test(rawTag);

    // <svg> wrappers are transparent: children stream as top-level elements.
    if (name.toLowerCase() === "svg") return;

    if (isClosing) {
      if (stack.length === 0) return;
      element += rawTag;
      const index = stack.lastIndexOf(name);
      if (index === -1) return;
      stack.length = index;
      if (stack.length === 0) emit();
      return;
    }

    element += rawTag;
    if (!isSelfClosing) stack.push(name);
    if (stack.length === 0) emit();
  }

  function scan() {
    while (pending.length > 0) {
      if (element.length > MAX_ELEMENT_CHARS) resetElement();

      const open = pending.indexOf("<");
      if (open === -1) {
        if (stack.length > 0) element += pending;
        pending = "";
        return;
      }

      if (open > 0) {
        if (stack.length > 0) element += pending.slice(0, open);
        pending = pending.slice(open);
      }

      // Need at least "<x" to classify what kind of markup this is.
      if (pending.length < 2) return;

      if (pending.startsWith("<!--")) {
        const end = pending.indexOf("-->");
        if (end === -1) return guardPending();
        pending = pending.slice(end + 3);
        continue;
      }

      if (pending[1] === "!" || pending[1] === "?") {
        const end = pending.indexOf(">");
        if (end === -1) return guardPending();
        pending = pending.slice(end + 1);
        continue;
      }

      if (!/[A-Za-z/]/.test(pending[1])) {
        if (stack.length > 0) element += "<";
        pending = pending.slice(1);
        continue;
      }

      const close = findTagEnd(pending);
      if (close === -1) return guardPending();

      handleTag(pending.slice(0, close + 1));
      pending = pending.slice(close + 1);
    }
  }

  function guardPending() {
    if (pending.length > MAX_PENDING_CHARS) {
      pending = "";
      resetElement();
    }
  }

  return {
    push(text) {
      pending += text;
      scan();
    },
    flush() {
      pending = "";
      resetElement();
    },
  };
}

// Index of the '>' that ends the tag starting at text[0], honoring quotes.
function findTagEnd(text) {
  let quote = "";
  for (let i = 1; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return i;
    }
  }
  return -1;
}

export function elementTagName(markup) {
  const match = markup.match(/^<\s*([A-Za-z][\w:.-]*)/);
  return match ? match[1] : "";
}

export function parseBatchElement(markup) {
  if (elementTagName(markup).toLowerCase() !== CONTROL_TAG) return null;
  const attrs = markup.slice(markup.indexOf(CONTROL_TAG) + CONTROL_TAG.length);
  const continueMatch = /continue\s*=\s*["']?\s*(true|false|yes|no)/i.exec(attrs);
  const noteMatch = /note\s*=\s*"([^"]*)"/.exec(attrs) || /note\s*=\s*'([^']*)'/.exec(attrs);
  return {
    continue: continueMatch ? /true|yes/i.test(continueMatch[1]) : false,
    note: noteMatch ? noteMatch[1].slice(0, 200) : "",
  };
}

// Server-side screen: reject unknown tags and strip the obvious script
// vectors. The browser re-sanitizes with a real DOM parser before painting.
export function screenSvgElement(markup) {
  const tags = [...markup.matchAll(/<\s*\/?\s*([A-Za-z][\w:.-]*)/g)].map((m) => m[1]);
  for (const tag of tags) {
    if (!SVG_ELEMENT_TAGS.has(tag)) {
      return { ok: false, reason: `Disallowed SVG element: <${tag}>.` };
    }
  }
  if (/javascript:/i.test(markup)) {
    return { ok: false, reason: "Blocked javascript: URI in SVG." };
  }
  const cleaned = markup.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  return { ok: true, markup: cleaned };
}
