const canvas = document.querySelector("#paintCanvas");
const previewCanvas = document.querySelector("#previewCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
const previewCtx = previewCanvas.getContext("2d");

const toolButtons = [...document.querySelectorAll(".tool-button")];
const colorInput = document.querySelector("#colorInput");
const brushSize = document.querySelector("#brushSize");
const brushOutput = document.querySelector("#brushOutput");
const swatches = document.querySelector("#swatches");
const undoBtn = document.querySelector("#undoBtn");
const clearBtn = document.querySelector("#clearBtn");
const exportBtn = document.querySelector("#exportBtn");
const cursorStatus = document.querySelector("#cursorStatus");
const agentStatus = document.querySelector("#agentStatus");
const providerSelect = document.querySelector("#providerSelect");
const apiBaseUrl = document.querySelector("#apiBaseUrl");
const modelSelect = document.querySelector("#modelSelect");
const modelName = document.querySelector("#modelName");
const apiKeyInput = document.querySelector("#apiKeyInput");
const agentPrompt = document.querySelector("#agentPrompt");
const referenceInput = document.querySelector("#referenceInput");
const referencePreview = document.querySelector("#referencePreview");
const autoLoop = document.querySelector("#autoLoop");
const useVision = document.querySelector("#useVision");
const maxTurns = document.querySelector("#maxTurns");
const creativityInput = document.querySelector("#creativityInput");
const creativityOutput = document.querySelector("#creativityOutput");
const startAgentBtn = document.querySelector("#startAgentBtn");
const newAgentBtn = document.querySelector("#newAgentBtn");
const stepAgentBtn = document.querySelector("#stepAgentBtn");
const stopAgentBtn = document.querySelector("#stopAgentBtn");
const eventLog = document.querySelector("#eventLog");

const HISTORY_LIMIT = 40;
const RECENT_ELEMENT_LIMIT = 24;
const ELEMENT_HISTORY_LIMIT = 120;
const ELEMENT_SNIPPET_LIMIT = 400;
const PROMPT_HISTORY_LIMIT = 20;
const SVG_NS = "http://www.w3.org/2000/svg";
const CUSTOM_MODEL_OPTION = "__custom__";
const ALLOWED_SVG_TAGS = new Set([
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
const SWATCHES = [
  "#111827",
  "#ffffff",
  "#ef4444",
  "#f97316",
  "#facc15",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#6366f1",
  "#a855f7",
  "#ec4899",
  "#7c2d12",
];

const state = {
  tool: "pencil",
  color: colorInput.value,
  brushSize: Number(brushSize.value),
  isDrawing: false,
  startPoint: null,
  lastPoint: null,
  undoStack: [],
  elementQueue: [],
  queueRunning: false,
  ws: null,
  agentRunning: false,
  providerDefaults: new Map(),
  visionSupported: false,
  visionUserChanged: false,
  modelStreaming: false,
  modelDonePending: false,
  continueRequested: true,
  currentTurn: 0,
  maxTurns: Number(maxTurns.value),
  creativity: Number(creativityInput.value),
  creativeRunActive: false,
  noProgressTurns: 0,
  agentSessionStarted: false,
  recentElements: [],
  elementHistory: [],
  promptHistory: [],
  reference: null,
  // Gradients/symbols defined by earlier elements, kept so later elements
  // can reference them: each element is rasterized as a standalone SVG.
  svgDefsById: new Map(),
};

ctx.lineCap = "round";
ctx.lineJoin = "round";
previewCtx.lineCap = "round";
previewCtx.lineJoin = "round";

clearCanvas(false);
buildSwatches();
loadServerConfig();
installManualDrawing();
installControls();
publishAgentApi();
setStatus("Idle");

async function loadServerConfig() {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    applyServerConfig(await response.json());
  } catch {
    applyServerConfig({});
  }
}

function applyServerConfig(config) {
  configureProviders(config.providers);
  providerSelect.value = config.provider || "llama";
  const defaults = state.providerDefaults.get(providerSelect.value) || {};
  apiBaseUrl.value = config.apiBaseUrl || defaults.apiBaseUrl || "http://127.0.0.1:8081";
  updateProviderKeyHint(providerSelect.value);
  setVisionSupported(Boolean(config.visionSupported));
  refreshModelList(config.model || defaults.model || "");
}

function configureProviders(providers = []) {
  const defaults =
    Array.isArray(providers) && providers.length > 0 ? providers : getFallbackProviders();
  state.providerDefaults = new Map(defaults.map((provider) => [provider.id, provider]));
  providerSelect.replaceChildren(
    ...defaults.map((provider) => {
      const option = document.createElement("option");
      option.value = provider.id;
      option.textContent = provider.label;
      return option;
    }),
  );
}

function getFallbackProviders() {
  return [
    {
      id: "llama",
      label: "Local llama.cpp",
      apiBaseUrl: "http://127.0.0.1:8081",
      model: "gemma-4-26B-A4B-it-Q4_K_M.gguf",
      visionDefault: false,
    },
    {
      id: "openai",
      label: "OpenAI",
      apiBaseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      needsApiKey: true,
      visionDefault: true,
    },
    {
      id: "anthropic",
      label: "Claude",
      apiBaseUrl: "https://api.anthropic.com/v1",
      model: "claude-opus-4-8",
      needsApiKey: true,
      visionDefault: true,
    },
    {
      id: "custom",
      label: "Custom OpenAI-compatible",
      apiBaseUrl: "http://127.0.0.1:8081",
      model: "",
      visionDefault: true,
    },
  ];
}

function applyProviderDefaults(providerId) {
  const defaults = state.providerDefaults.get(providerId);
  if (!defaults) return;

  apiBaseUrl.value = defaults.apiBaseUrl || "";
  apiKeyInput.value = "";
  updateProviderKeyHint(providerId);
  state.visionUserChanged = false;
  setVisionSupported(Boolean(defaults.visionDefault));
  refreshModelList(defaults.model || "");
  logEvent(`provider: ${defaults.label}`);
}

function currentModel() {
  return modelSelect.value === CUSTOM_MODEL_OPTION ? modelName.value.trim() : modelSelect.value;
}

function syncCustomModelVisibility() {
  modelName.classList.toggle("hidden", modelSelect.value !== CUSTOM_MODEL_OPTION);
}

function setModelOptions(models, selected) {
  const ids = new Set(models.map((model) => model.id));
  const options = models.map((model) => makeOption(model.id, model.label || model.id));
  if (selected && !ids.has(selected)) {
    options.unshift(makeOption(selected, selected));
  }
  options.push(makeOption(CUSTOM_MODEL_OPTION, "Custom..."));
  modelSelect.replaceChildren(...options);
  modelSelect.value = selected || options[0].value;
  if (modelSelect.value === CUSTOM_MODEL_OPTION && selected !== CUSTOM_MODEL_OPTION) {
    modelSelect.value = options[0].value;
  }
  syncCustomModelVisibility();
}

function makeOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

async function refreshModelList(selected) {
  const fallback = selected || state.providerDefaults.get(providerSelect.value)?.model || "";
  setModelOptions([], fallback);

  try {
    const response = await fetch("/api/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: providerSelect.value,
        apiBaseUrl: apiBaseUrl.value.trim(),
        apiKey: apiKeyInput.value.trim(),
      }),
    });
    const payload = await response.json();

    if (payload.models?.length) {
      setModelOptions(payload.models, fallback);
      logEvent(`models: ${payload.models.length} available`);
    } else if (payload.error) {
      logEvent(`model list unavailable: ${payload.error}`, "warn");
    }
  } catch {
    logEvent("model list request failed; type a model id via Custom...", "warn");
  }
}

function updateProviderKeyHint(providerId) {
  const defaults = state.providerDefaults.get(providerId);
  apiKeyInput.placeholder = defaults?.needsApiKey
    ? "Uses provider env var if blank"
    : "Optional for local endpoints";
}

function buildSwatches() {
  swatches.replaceChildren(
    ...SWATCHES.map((color) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "swatch";
      button.title = color;
      button.style.backgroundColor = color;
      button.addEventListener("click", () => setColor(color));
      return button;
    }),
  );
}

function installControls() {
  toolButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.tool = button.dataset.tool;
      toolButtons.forEach((item) => item.classList.toggle("active", item === button));
    });
  });

  colorInput.addEventListener("input", () => setColor(colorInput.value));
  brushSize.addEventListener("input", () => setBrush(Number(brushSize.value)));
  providerSelect.addEventListener("change", () => applyProviderDefaults(providerSelect.value));
  modelSelect.addEventListener("change", syncCustomModelVisibility);
  apiBaseUrl.addEventListener("change", () => refreshModelList(currentModel()));
  apiKeyInput.addEventListener("change", () => refreshModelList(currentModel()));
  useVision.addEventListener("change", () => {
    state.visionUserChanged = true;
  });
  undoBtn.addEventListener("click", () => undo());
  clearBtn.addEventListener("click", () => resetAgentSession({ clear: true }));
  exportBtn.addEventListener("click", exportPng);
  startAgentBtn.addEventListener("click", startAgent);
  newAgentBtn.addEventListener("click", () => resetAgentSession({ clear: true }));
  stepAgentBtn.addEventListener("click", () => sendFeedbackStep({ userInitiated: true }));
  stopAgentBtn.addEventListener("click", stopAgent);
  maxTurns.addEventListener("input", () => {
    state.maxTurns = clampInt(maxTurns.value, 1, 40, 12);
  });
  creativityInput.addEventListener("input", () => {
    state.creativity = clampInt(creativityInput.value, 0, 100, 82);
    creativityOutput.value = String(state.creativity);
    creativityOutput.textContent = String(state.creativity);
  });

  referenceInput.addEventListener("change", async () => {
    const file = referenceInput.files?.[0];
    if (!file) {
      state.reference = null;
      referencePreview.textContent = "";
      return;
    }

    try {
      state.reference = await downscaleImageFile(file, 512, 0.78);
      const img = document.createElement("img");
      img.src = state.reference.image;
      img.alt = "Reference preview";
      referencePreview.replaceChildren(img);
      logEvent(`reference loaded: ${file.name}`);
    } catch (error) {
      state.reference = null;
      referencePreview.textContent = "";
      logEvent(error.message || String(error), "error");
    }
  });
}

// --- Manual painting ---------------------------------------------------

function installManualDrawing() {
  canvas.addEventListener("pointerdown", (event) => {
    const point = getCanvasPoint(event);
    canvas.setPointerCapture(event.pointerId);
    cursorStatus.textContent = `${Math.round(point.x)}, ${Math.round(point.y)}`;

    if (state.tool === "fill") {
      saveUndo();
      floodFill(Math.round(point.x), Math.round(point.y), hexToRgba(state.color));
      return;
    }

    if (state.tool === "text") {
      const text = window.prompt("Text");
      if (text) {
        saveUndo();
        drawText(point.x, point.y, text, Math.max(12, state.brushSize * 5));
      }
      return;
    }

    saveUndo();
    state.isDrawing = true;
    state.startPoint = point;
    state.lastPoint = point;

    if (state.tool === "pencil" || state.tool === "eraser") {
      drawSegment(point, point);
    }
  });

  canvas.addEventListener("pointermove", (event) => {
    const point = getCanvasPoint(event);
    cursorStatus.textContent = `${Math.round(point.x)}, ${Math.round(point.y)}`;
    if (!state.isDrawing) return;

    if (state.tool === "pencil" || state.tool === "eraser") {
      drawSegment(state.lastPoint, point);
      state.lastPoint = point;
      return;
    }

    drawPreviewShape(state.startPoint, point);
  });

  canvas.addEventListener("pointerup", finishPointerDrawing);
  canvas.addEventListener("pointercancel", finishPointerDrawing);
  canvas.addEventListener("pointerleave", (event) => {
    if (state.isDrawing && event.buttons === 0) finishPointerDrawing(event);
  });
}

function finishPointerDrawing(event) {
  if (!state.isDrawing) return;
  const point = getCanvasPoint(event);
  state.isDrawing = false;
  clearPreview();

  ctx.save();
  applyStrokeStyle(ctx);
  if (state.tool === "line") {
    ctx.beginPath();
    ctx.moveTo(state.startPoint.x, state.startPoint.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
  } else if (state.tool === "rect") {
    const rect = rectFromPoints(state.startPoint, point);
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  } else if (state.tool === "ellipse") {
    const rect = rectFromPoints(state.startPoint, point);
    ctx.beginPath();
    ctx.ellipse(
      rect.x + rect.w / 2,
      rect.y + rect.h / 2,
      Math.max(1, rect.w / 2),
      Math.max(1, rect.h / 2),
      0,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
  }
  ctx.restore();

  state.startPoint = null;
  state.lastPoint = null;
}

function drawPreviewShape(start, end) {
  clearPreview();
  previewCtx.save();
  applyStrokeStyle(previewCtx);
  previewCtx.setLineDash([5, 5]);

  if (state.tool === "line") {
    previewCtx.beginPath();
    previewCtx.moveTo(start.x, start.y);
    previewCtx.lineTo(end.x, end.y);
    previewCtx.stroke();
  } else if (state.tool === "rect") {
    const rect = rectFromPoints(start, end);
    previewCtx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  } else if (state.tool === "ellipse") {
    const rect = rectFromPoints(start, end);
    previewCtx.beginPath();
    previewCtx.ellipse(
      rect.x + rect.w / 2,
      rect.y + rect.h / 2,
      Math.max(1, rect.w / 2),
      Math.max(1, rect.h / 2),
      0,
      0,
      Math.PI * 2,
    );
    previewCtx.stroke();
  }

  previewCtx.restore();
}

function clearPreview() {
  previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
}

function getCanvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: clampNumber(((event.clientX - rect.left) / rect.width) * canvas.width, 0, canvas.width),
    y: clampNumber(((event.clientY - rect.top) / rect.height) * canvas.height, 0, canvas.height),
  };
}

function setColor(color) {
  const normalized = normalizeHex(color);
  if (!normalized) return;
  state.color = normalized;
  colorInput.value = normalized;
}

function setBrush(size) {
  state.brushSize = clampInt(size, 1, 60, 4);
  brushSize.value = String(Math.min(48, state.brushSize));
  brushOutput.value = `${state.brushSize} px`;
  brushOutput.textContent = `${state.brushSize} px`;
}

function applyStrokeStyle(targetCtx) {
  const color = state.tool === "eraser" ? "#ffffff" : state.color;
  targetCtx.strokeStyle = color;
  targetCtx.fillStyle = color;
  targetCtx.lineWidth = state.brushSize;
  targetCtx.lineCap = "round";
  targetCtx.lineJoin = "round";
}

function drawSegment(from, to) {
  ctx.save();
  applyStrokeStyle(ctx);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.restore();
}

function drawText(x, y, text, size) {
  ctx.save();
  ctx.fillStyle = state.color;
  ctx.font = `${clampInt(size, 8, 96, 22)}px Arial, sans-serif`;
  ctx.textBaseline = "top";
  ctx.fillText(
    String(text)
      .replace(/\p{Cc}/gu, "")
      .slice(0, 80),
    x,
    y,
  );
  ctx.restore();
}

function rectFromPoints(start, end) {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    w: Math.abs(end.x - start.x),
    h: Math.abs(end.y - start.y),
  };
}

function saveUndo() {
  state.undoStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
  if (state.undoStack.length > HISTORY_LIMIT) state.undoStack.shift();
}

function undo(count = 1) {
  let steps = clampInt(count, 1, 8, 1);
  while (steps > 0 && state.undoStack.length > 0) {
    ctx.putImageData(state.undoStack.pop(), 0, 0);
    steps -= 1;
  }
}

function clearCanvas(remember = true) {
  if (remember) saveUndo();
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
}

function exportPng() {
  const link = document.createElement("a");
  link.download = `agent-paint-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

function floodFill(startX, startY, fillColor) {
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data, width, height } = image;
  const startIndex = (startY * width + startX) * 4;
  const target = [
    data[startIndex],
    data[startIndex + 1],
    data[startIndex + 2],
    data[startIndex + 3],
  ];

  if (colorsClose(target, fillColor, 0)) return;

  const stack = [[startX, startY]];
  const tolerance = 16;

  while (stack.length > 0) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= width || y >= height) continue;

    const index = (y * width + x) * 4;
    const current = [data[index], data[index + 1], data[index + 2], data[index + 3]];
    if (!colorsClose(current, target, tolerance)) continue;

    data[index] = fillColor[0];
    data[index + 1] = fillColor[1];
    data[index + 2] = fillColor[2];
    data[index + 3] = 255;

    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }

  ctx.putImageData(image, 0, 0);
}

function colorsClose(a, b, tolerance) {
  return (
    Math.abs(a[0] - b[0]) <= tolerance &&
    Math.abs(a[1] - b[1]) <= tolerance &&
    Math.abs(a[2] - b[2]) <= tolerance &&
    Math.abs((a[3] ?? 255) - (b[3] ?? 255)) <= tolerance
  );
}

function hexToRgba(color) {
  const normalized = normalizeHex(color) || "#000000";
  return [
    Number.parseInt(normalized.slice(1, 3), 16),
    Number.parseInt(normalized.slice(3, 5), 16),
    Number.parseInt(normalized.slice(5, 7), 16),
    255,
  ];
}

// --- Agent SVG painting ------------------------------------------------

function publishAgentApi() {
  window.paintAgent = {
    svg: (markup) => enqueueSvgElement(String(markup)),
    clear: () => clearCanvas(true),
    undo,
    exportPng,
    snapshot: captureCanvasFeedback,
  };
}

function enqueueSvgElement(markup) {
  const sanitized = sanitizeSvgMarkup(markup);
  if (!sanitized) {
    logEvent("blocked unsafe or malformed SVG element", "warn");
    return false;
  }
  state.elementQueue.push(sanitized);
  runElementQueue();
  return true;
}

async function runElementQueue() {
  if (state.queueRunning) return;
  state.queueRunning = true;

  while (state.elementQueue.length > 0) {
    const markup = state.elementQueue.shift();
    saveUndo();
    rememberAgentElement(markup);
    try {
      await paintSvgElement(markup);
    } catch {
      logEvent("element failed to render", "warn");
    }
    await delay(110);
  }

  state.queueRunning = false;
  maybeContinueAgent();
}

// Parse with a real XML parser, drop anything outside the allowlist, strip
// event handlers and external references, and return serialized markup.
function sanitizeSvgMarkup(markup) {
  const doc = new DOMParser().parseFromString(
    `<svg xmlns="${SVG_NS}">${markup}</svg>`,
    "image/svg+xml",
  );
  if (doc.querySelector("parsererror")) return null;

  const root = doc.documentElement;
  for (const el of [...root.querySelectorAll("*")]) {
    if (!ALLOWED_SVG_TAGS.has(el.localName)) {
      el.remove();
      continue;
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (name.startsWith("on") || /javascript:/i.test(value)) {
        el.removeAttribute(attr.name);
      } else if ((name === "href" || name.endsWith(":href")) && !value.startsWith("#")) {
        el.removeAttribute(attr.name);
      } else if (/url\s*\(/i.test(value) && !/url\s*\(\s*["']?#/i.test(value)) {
        el.removeAttribute(attr.name);
      }
    }
  }

  const serializer = new XMLSerializer();
  for (const def of root.querySelectorAll("linearGradient, radialGradient, symbol")) {
    if (def.id) {
      state.svgDefsById.set(def.id, serializer.serializeToString(def));
      if (state.svgDefsById.size > 80) {
        state.svgDefsById.delete(state.svgDefsById.keys().next().value);
      }
    }
  }

  const result = [...root.childNodes].map((node) => serializer.serializeToString(node)).join("");
  return result.trim() || null;
}

function paintSvgElement(markup) {
  const defs = state.svgDefsById.size
    ? `<defs>${[...state.svgDefsById.values()].join("")}</defs>`
    : "";
  const svg = `<svg xmlns="${SVG_NS}" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}">${defs}${markup}</svg>`;
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  return loadImage(url)
    .then((image) => {
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    })
    .finally(() => URL.revokeObjectURL(url));
}

function rememberAgentElement(markup) {
  const snippet =
    markup.length > ELEMENT_SNIPPET_LIMIT ? `${markup.slice(0, ELEMENT_SNIPPET_LIMIT)}...` : markup;
  state.recentElements.push(snippet);
  state.elementHistory.push(snippet);

  if (state.recentElements.length > RECENT_ELEMENT_LIMIT) state.recentElements.shift();
  if (state.elementHistory.length > ELEMENT_HISTORY_LIMIT) state.elementHistory.shift();
}

// --- Agent session -----------------------------------------------------

async function startAgent() {
  await ensureSocket();
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;

  const hasExistingSession = state.agentSessionStarted && state.elementHistory.length > 0;
  const mode = hasExistingSession ? "edit" : "new";
  const prompt = agentPrompt.value.trim();
  const isBlankNewPrompt = mode === "new" && prompt.length === 0;
  if (isBlankNewPrompt) {
    state.creativeRunActive = true;
  } else if (prompt.length > 0) {
    state.creativeRunActive = false;
  }

  state.agentRunning = true;
  state.modelDonePending = false;
  state.continueRequested = true;
  state.maxTurns = state.currentTurn + clampInt(maxTurns.value, 1, 40, 12);
  state.noProgressTurns = 0;
  state.agentSessionStarted = true;
  rememberPrompt(prompt, mode);
  setAgentButtons();
  logEvent(hasExistingSession ? "sending edit prompt" : "starting new agent drawing");

  state.ws.send(
    JSON.stringify({
      type: hasExistingSession ? "feedback" : "start",
      mode,
      prompt,
      choiceNonce: isBlankNewPrompt ? randomNonce() : "",
      config: getModelConfig({ blankNewPrompt: isBlankNewPrompt }),
      useVision: useVision.checked,
      canvas: await captureCanvasFeedback(useVision.checked),
      reference: state.reference,
      recentElements: state.recentElements,
      elementHistory: state.elementHistory,
      promptHistory: state.promptHistory,
      turnBudget: getTurnBudgetPayload(),
    }),
  );

  state.recentElements = [];
}

async function sendFeedbackStep({ userInitiated = false } = {}) {
  await ensureSocket();
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN || state.modelStreaming) return;

  state.agentRunning = true;
  state.agentSessionStarted = true;
  if (userInitiated) {
    state.maxTurns = state.currentTurn + clampInt(maxTurns.value, 1, 40, 12);
    state.noProgressTurns = 0;
  }
  setAgentButtons();
  logEvent("sending feedback step");

  state.ws.send(
    JSON.stringify({
      type: "feedback",
      mode: "continue",
      prompt: agentPrompt.value,
      config: getModelConfig({ blankNewPrompt: state.creativeRunActive }),
      useVision: useVision.checked,
      canvas: await captureCanvasFeedback(useVision.checked),
      reference: state.reference,
      recentElements: state.recentElements,
      elementHistory: state.elementHistory,
      promptHistory: state.promptHistory,
      turnBudget: getTurnBudgetPayload(),
    }),
  );

  state.recentElements = [];
}

function stopAgent() {
  state.agentRunning = false;
  state.modelStreaming = false;
  state.modelDonePending = false;
  state.continueRequested = false;
  state.noProgressTurns = 0;
  state.creativeRunActive = false;
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: "stop" }));
  }
  setAgentButtons();
  setStatus("Stopped");
}

function resetAgentSession({ clear = false } = {}) {
  stopAgent();
  if (clear) clearCanvas(true);
  state.agentSessionStarted = false;
  state.modelDonePending = false;
  state.continueRequested = true;
  state.currentTurn = 0;
  state.maxTurns = clampInt(maxTurns.value, 1, 40, 12);
  state.noProgressTurns = 0;
  state.creativeRunActive = false;
  state.recentElements = [];
  state.elementHistory = [];
  state.promptHistory = [];
  state.svgDefsById.clear();
  setAgentButtons();
  setStatus(clear ? "New canvas" : "Agent reset");
  logEvent(clear ? "new canvas and agent memory reset" : "agent memory reset");
}

async function ensureSocket() {
  if (state.ws?.readyState === WebSocket.OPEN) return;

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  state.ws = new WebSocket(`${protocol}//${window.location.host}/agent`);

  await new Promise((resolve) => {
    state.ws.addEventListener("open", resolve, { once: true });
    state.ws.addEventListener(
      "error",
      () => {
        logEvent("could not open agent socket", "error");
        resolve();
      },
      { once: true },
    );
  });

  state.ws.addEventListener("message", handleSocketMessage);
  state.ws.addEventListener("close", () => {
    state.agentRunning = false;
    state.modelStreaming = false;
    state.modelDonePending = false;
    setAgentButtons();
    setStatus("Socket closed");
  });
}

function handleSocketMessage(event) {
  const message = JSON.parse(event.data);

  if (message.type === "hello") {
    if (message.providers) configureProviders(message.providers);
    if (message.provider && !providerSelect.value) providerSelect.value = message.provider;
    if (!apiBaseUrl.value) apiBaseUrl.value = message.apiBaseUrl || "";
    updateProviderKeyHint(providerSelect.value);
    setVisionSupported(Boolean(message.visionSupported));
    return;
  }

  if (message.type === "modelStart") {
    state.modelStreaming = true;
    state.modelDonePending = false;
    state.currentTurn = message.turn;
    state.continueRequested = true;
    setAgentButtons();
    setStatus(`Turn ${message.turn}: streaming`);
    logEvent(
      `model start: ${message.model || ""} via ${message.providerLabel || message.provider}`,
    );
    if (message.usingVision) logEvent("vision feedback included");
    return;
  }

  if (message.type === "element") {
    logEvent(message.markup, "command");
    enqueueSvgElement(message.markup);
    return;
  }

  if (message.type === "batch") {
    state.continueRequested = Boolean(message.continue);
    if (message.note) logEvent(`batch: ${message.note}`);
    return;
  }

  if (message.type === "modelWarning") {
    logEvent(message.message, "warn");
    return;
  }

  if (message.type === "modelDone") {
    state.modelStreaming = false;
    state.modelDonePending = true;
    state.continueRequested = Boolean(message.continue);
    state.noProgressTurns = message.elementsThisTurn > 0 ? 0 : state.noProgressTurns + 1;
    setStatus(
      message.aborted
        ? "Stopped"
        : `Turn ${message.turn} done: ${message.elementsThisTurn} elements`,
    );
    logEvent(`model done: ${message.elementsThisTurn} elements`);
    if (message.retriedWithoutVision) {
      logEvent("completed after retrying without screenshots", "warn");
    }
    setAgentButtons();
    maybeContinueAgent();
    return;
  }

  if (message.type === "status") {
    logEvent(message.message);
    return;
  }

  if (message.type === "error") {
    state.modelStreaming = false;
    state.modelDonePending = false;
    state.agentRunning = false;
    setAgentButtons();
    setStatus("Error");
    logEvent(message.message, "error");
  }
}

async function maybeContinueAgent() {
  if (!state.agentRunning || !autoLoop.checked) return;
  if (state.queueRunning || state.modelStreaming || !state.modelDonePending) return;

  if (state.noProgressTurns >= 2) {
    state.agentRunning = false;
    state.modelDonePending = false;
    setAgentButtons();
    setStatus("Stopped: no progress");
    logEvent("stopped after two empty model batches", "warn");
    return;
  }

  if (!state.continueRequested) {
    state.agentRunning = false;
    state.modelDonePending = false;
    setAgentButtons();
    setStatus("Finished");
    logEvent("model chose to stop");
    return;
  }

  if (state.currentTurn >= state.maxTurns) {
    state.agentRunning = false;
    state.modelDonePending = false;
    setAgentButtons();
    setStatus("Max turns reached");
    return;
  }

  state.modelDonePending = false;
  await delay(250);
  await sendFeedbackStep();
}

function getTurnBudgetPayload() {
  return {
    currentTurn: state.currentTurn,
    maxTurns: state.maxTurns,
    remainingAfterThisRequest: Math.max(0, state.maxTurns - state.currentTurn - 1),
    autoLoop: autoLoop.checked,
  };
}

function getModelConfig({ blankNewPrompt = false } = {}) {
  const sampling = blankNewPrompt ? getCreativeSamplingConfig(state.creativity) : {};

  return {
    provider: providerSelect.value,
    apiBaseUrl: apiBaseUrl.value.trim(),
    model: currentModel(),
    apiKey: apiKeyInput.value.trim(),
    temperature: blankNewPrompt ? sampling.temperature : 0.65,
    maxTokens: 2000,
    seed: blankNewPrompt ? randomSeed() : null,
    ...sampling,
  };
}

function getCreativeSamplingConfig(creativity) {
  const value = clampNumber(creativity, 0, 100, 82) / 100;

  return {
    temperature: roundTo(0.85 + value * 0.65, 2),
    topP: roundTo(0.9 + value * 0.09, 3),
    topK: clampInt(40 + value * 160, 40, 200, 168),
    minP: roundTo(0.05 - value * 0.04, 3),
  };
}

// --- Canvas feedback ----------------------------------------------------

async function captureCanvasFeedback(includeImage = false) {
  const payload = {
    width: canvas.width,
    height: canvas.height,
    stats: summarizeCanvas(),
  };

  if (includeImage) {
    payload.image = await canvasToDataUrl(canvas, 384, 0.72);
  }

  return payload;
}

function summarizeCanvas() {
  const sampleWidth = 96;
  const sampleHeight = 64;
  const scratch = document.createElement("canvas");
  scratch.width = sampleWidth;
  scratch.height = sampleHeight;
  const scratchCtx = scratch.getContext("2d", { willReadFrequently: true });
  scratchCtx.drawImage(canvas, 0, 0, sampleWidth, sampleHeight);
  const data = scratchCtx.getImageData(0, 0, sampleWidth, sampleHeight).data;

  let marked = 0;
  let minX = sampleWidth;
  let minY = sampleHeight;
  let maxX = 0;
  let maxY = 0;
  const buckets = new Map();

  for (let y = 0; y < sampleHeight; y += 1) {
    for (let x = 0; x < sampleWidth; x += 1) {
      const index = (y * sampleWidth + x) * 4;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const a = data[index + 3];
      const isWhite = a < 12 || (r > 244 && g > 244 && b > 244);
      if (isWhite) continue;

      marked += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);

      const key = [Math.round(r / 32) * 32, Math.round(g / 32) * 32, Math.round(b / 32) * 32].join(
        ",",
      );
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
  }

  const dominant = [...buckets.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([key, count]) => {
      const [r, g, b] = key.split(",").map((value) => clampInt(value, 0, 255, 0));
      return { color: rgbToHex(r, g, b), count };
    });

  const coverage = marked / (sampleWidth * sampleHeight);
  const bbox =
    marked === 0
      ? null
      : {
          x: Math.round((minX / sampleWidth) * canvas.width),
          y: Math.round((minY / sampleHeight) * canvas.height),
          w: Math.round(((maxX - minX + 1) / sampleWidth) * canvas.width),
          h: Math.round(((maxY - minY + 1) / sampleHeight) * canvas.height),
        };

  return {
    coverage,
    bbox,
    dominant,
    summary:
      marked === 0
        ? "blank white canvas"
        : `non-white coverage ${(coverage * 100).toFixed(1)}%, bounding box ${JSON.stringify(
            bbox,
          )}, dominant colors ${dominant.map((item) => item.color).join(", ")}`,
  };
}

async function canvasToDataUrl(source, maxSize, quality) {
  const scale = Math.min(1, maxSize / Math.max(source.width, source.height));
  const scratch = document.createElement("canvas");
  scratch.width = Math.max(1, Math.round(source.width * scale));
  scratch.height = Math.max(1, Math.round(source.height * scale));
  const scratchCtx = scratch.getContext("2d");
  scratchCtx.fillStyle = "#ffffff";
  scratchCtx.fillRect(0, 0, scratch.width, scratch.height);
  scratchCtx.drawImage(source, 0, 0, scratch.width, scratch.height);
  return scratch.toDataURL("image/jpeg", quality);
}

async function downscaleImageFile(file, maxSize, quality) {
  const dataUrl = await readFileAsDataUrl(file);
  const image = await loadImage(dataUrl);
  const scratch = document.createElement("canvas");
  const scale = Math.min(1, maxSize / Math.max(image.naturalWidth, image.naturalHeight));
  scratch.width = Math.max(1, Math.round(image.naturalWidth * scale));
  scratch.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const scratchCtx = scratch.getContext("2d");
  scratchCtx.fillStyle = "#ffffff";
  scratchCtx.fillRect(0, 0, scratch.width, scratch.height);
  scratchCtx.drawImage(image, 0, 0, scratch.width, scratch.height);
  return {
    width: scratch.width,
    height: scratch.height,
    image: scratch.toDataURL("image/jpeg", quality),
  };
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image));
    image.addEventListener("error", () => reject(new Error("Could not load image.")));
    image.src = src;
  });
}

// --- UI helpers ----------------------------------------------------------

function setAgentButtons() {
  startAgentBtn.disabled = state.modelStreaming;
  newAgentBtn.disabled = state.modelStreaming;
  stepAgentBtn.disabled = state.modelStreaming;
  stopAgentBtn.disabled = !state.agentRunning && !state.modelStreaming;
}

function setVisionSupported(supported) {
  state.visionSupported = supported;
  useVision.title = supported
    ? "Canvas screenshots are sent to the provider on each agent turn."
    : "The current endpoint has not reported vision support.";

  if (!state.visionUserChanged) {
    useVision.checked = supported;
  }
}

function rememberPrompt(prompt, mode) {
  state.promptHistory.push({
    mode,
    turn: state.currentTurn,
    prompt: (prompt || "(agent chose subject)").slice(0, 240),
  });

  if (state.promptHistory.length > PROMPT_HISTORY_LIMIT) {
    state.promptHistory.shift();
  }
}

function setStatus(message) {
  agentStatus.textContent = message;
}

function logEvent(message, className = "") {
  const row = document.createElement("div");
  if (className) row.className = className;
  row.textContent = message;
  eventLog.appendChild(row);
  while (eventLog.children.length > 180) {
    eventLog.firstChild.remove();
  }
  eventLog.scrollTop = eventLog.scrollHeight;
}

function normalizeHex(value) {
  const color = String(value || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return color.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(color)) {
    return `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`.toLowerCase();
  }
  return null;
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b]
    .map((value) => clampInt(value, 0, 255, 0).toString(16).padStart(2, "0"))
    .join("")}`;
}

function clampNumber(value, min, max, fallback = min) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function clampInt(value, min, max, fallback = min) {
  return Math.round(clampNumber(value, min, max, fallback));
}

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function randomSeed() {
  const values = new Uint32Array(1);
  window.crypto.getRandomValues(values);
  return values[0];
}

function randomNonce() {
  const values = new Uint32Array(2);
  window.crypto.getRandomValues(values);
  return `${Date.now().toString(36)}-${[...values].map((value) => value.toString(36)).join("-")}`;
}
