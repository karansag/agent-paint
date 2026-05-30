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
const llamaUrl = document.querySelector("#llamaUrl");
const chatPath = document.querySelector("#chatPath");
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

const CANVAS_WIDTH = canvas.width;
const CANVAS_HEIGHT = canvas.height;
const HISTORY_LIMIT = 50;
const COMMAND_LOG_LIMIT = 32;
const AGENT_HISTORY_LIMIT = 180;
const PROMPT_HISTORY_LIMIT = 20;
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
  currentPoints: [],
  undoStack: [],
  commandQueue: [],
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
  recentAgentActions: [],
  agentActionHistory: [],
  promptHistory: [],
  reference: null,
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
    const config = await response.json();
    configureProviders(config.providers);
    providerSelect.value = config.provider || "llama";
    llamaUrl.value = config.apiBaseUrl || config.llamaServerUrl || "http://127.0.0.1:8081";
    chatPath.value = config.chatPath || config.llamaChatPath || "/v1/chat/completions";
    modelName.value = config.model || "gemma-4-26B-A4B-it-Q4_K_M.gguf";
    updateProviderKeyHint(providerSelect.value);
    setVisionSupported(Boolean(config.visionSupported));
  } catch {
    configureProviders();
    providerSelect.value = "llama";
    llamaUrl.value = "http://127.0.0.1:8081";
    chatPath.value = "/v1/chat/completions";
    modelName.value = "gemma-4-26B-A4B-it-Q4_K_M.gguf";
    updateProviderKeyHint(providerSelect.value);
    setVisionSupported(false);
  }
}

function configureProviders(providers = []) {
  const defaults = Array.isArray(providers) && providers.length > 0 ? providers : getFallbackProviders();
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
      chatPath: "/v1/chat/completions",
      model: "gemma-4-26B-A4B-it-Q4_K_M.gguf",
      visionDefault: false,
    },
    {
      id: "openai",
      label: "OpenAI",
      apiBaseUrl: "https://api.openai.com/v1",
      chatPath: "/chat/completions",
      model: "gpt-4.1-mini",
      visionDefault: true,
    },
    {
      id: "anthropic",
      label: "Claude",
      apiBaseUrl: "https://api.anthropic.com/v1",
      chatPath: "/chat/completions",
      model: "claude-sonnet-4-6",
      visionDefault: true,
    },
    {
      id: "custom",
      label: "Custom OpenAI-compatible",
      apiBaseUrl: "http://127.0.0.1:8081",
      chatPath: "/v1/chat/completions",
      model: "",
      visionDefault: true,
    },
  ];
}

function applyProviderDefaults(providerId) {
  const defaults = state.providerDefaults.get(providerId);
  if (!defaults) return;

  llamaUrl.value = defaults.apiBaseUrl || "";
  chatPath.value = defaults.chatPath || "/v1/chat/completions";
  modelName.value = defaults.model || "";
  apiKeyInput.value = "";
  updateProviderKeyHint(providerId);
  state.visionUserChanged = false;
  setVisionSupported(Boolean(defaults.visionDefault));
  logEvent(`provider: ${defaults.label}`);
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
  providerSelect.addEventListener("change", () => {
    applyProviderDefaults(providerSelect.value);
  });
  useVision.addEventListener("change", () => {
    state.visionUserChanged = true;
  });
  undoBtn.addEventListener("click", undo);
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
    state.currentPoints = [point];

    if (state.tool === "pencil" || state.tool === "eraser") {
      drawSegment(ctx, point, point, getActiveStrokeStyle());
    }
  });

  canvas.addEventListener("pointermove", (event) => {
    const point = getCanvasPoint(event);
    cursorStatus.textContent = `${Math.round(point.x)}, ${Math.round(point.y)}`;
    if (!state.isDrawing) return;

    if (state.tool === "pencil" || state.tool === "eraser") {
      drawSegment(ctx, state.lastPoint, point, getActiveStrokeStyle());
      state.lastPoint = point;
      state.currentPoints.push(point);
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

  if (state.tool === "line") {
    drawLine(state.startPoint.x, state.startPoint.y, point.x, point.y);
  } else if (state.tool === "rect") {
    drawRectFromPoints(state.startPoint, point, false);
  } else if (state.tool === "ellipse") {
    drawEllipseFromPoints(state.startPoint, point, false);
  }

  state.startPoint = null;
  state.lastPoint = null;
  state.currentPoints = [];
}

function drawPreviewShape(start, end) {
  clearPreview();
  previewCtx.save();
  applyStrokeStyle(previewCtx, getActiveStrokeStyle());
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

function getActiveStrokeStyle() {
  return {
    color: state.tool === "eraser" ? "#ffffff" : state.color,
    size: state.brushSize,
  };
}

function applyStrokeStyle(targetCtx, style) {
  targetCtx.strokeStyle = style.color;
  targetCtx.fillStyle = style.color;
  targetCtx.lineWidth = style.size;
  targetCtx.lineCap = "round";
  targetCtx.lineJoin = "round";
}

function drawSegment(targetCtx, from, to, style = { color: state.color, size: state.brushSize }) {
  targetCtx.save();
  applyStrokeStyle(targetCtx, style);
  targetCtx.beginPath();
  targetCtx.moveTo(from.x, from.y);
  targetCtx.lineTo(to.x, to.y);
  targetCtx.stroke();
  targetCtx.restore();
}

function drawLine(x1, y1, x2, y2) {
  drawSegment(ctx, { x: x1, y: y1 }, { x: x2, y: y2 });
}

function drawRect(x, y, w, h, fill = false) {
  ctx.save();
  applyStrokeStyle(ctx, { color: state.color, size: state.brushSize });
  if (fill) {
    ctx.fillRect(x, y, w, h);
  } else {
    ctx.strokeRect(x, y, w, h);
  }
  ctx.restore();
}

function drawRectFromPoints(start, end, fill) {
  const rect = rectFromPoints(start, end);
  drawRect(rect.x, rect.y, rect.w, rect.h, fill);
}

function drawEllipse(x, y, rx, ry, fill = false) {
  ctx.save();
  applyStrokeStyle(ctx, { color: state.color, size: state.brushSize });
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
  if (fill) ctx.fill();
  else ctx.stroke();
  ctx.restore();
}

function drawEllipseFromPoints(start, end, fill) {
  const rect = rectFromPoints(start, end);
  drawEllipse(rect.x + rect.w / 2, rect.y + rect.h / 2, rect.w / 2, rect.h / 2, fill);
}

function drawText(x, y, text, size) {
  ctx.save();
  ctx.fillStyle = state.color;
  ctx.font = `${clampInt(size, 8, 96, 22)}px Arial, sans-serif`;
  ctx.textBaseline = "top";
  ctx.fillText(String(text).slice(0, 80), x, y);
  ctx.restore();
}

function rectFromPoints(start, end) {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    x,
    y,
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
    const image = state.undoStack.pop();
    ctx.putImageData(image, 0, 0);
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

function publishAgentApi() {
  window.paintAgent = {
    setColor,
    setBrushSize: setBrush,
    stroke(points) {
      return enqueueCommand({ type: "stroke", points });
    },
    line(x1, y1, x2, y2) {
      return enqueueCommand({ type: "line", x1, y1, x2, y2 });
    },
    rect(x, y, w, h, options = {}) {
      return enqueueCommand({ type: "rect", x, y, w, h, fill: Boolean(options.fill) });
    },
    ellipse(x, y, rx, ry, options = {}) {
      return enqueueCommand({ type: "ellipse", x, y, rx, ry, fill: Boolean(options.fill) });
    },
    circle(x, y, r, options = {}) {
      return enqueueCommand({ type: "circle", x, y, r, fill: Boolean(options.fill) });
    },
    fill(x, y) {
      return enqueueCommand({ type: "fill", x, y });
    },
    text(x, y, text, size = 22) {
      return enqueueCommand({ type: "text", x, y, text, size });
    },
    clear() {
      clearCanvas(true);
    },
    undo,
    exportPng,
    snapshot: captureCanvasFeedback,
  };
}

function enqueueCommand(command, source = "manual") {
  const sanitized = sanitizeClientCommand(command);
  if (!sanitized) return Promise.resolve(false);
  state.commandQueue.push({ command: sanitized, source });
  runCommandQueue();
  return Promise.resolve(true);
}

async function runCommandQueue() {
  if (state.queueRunning) return;
  state.queueRunning = true;

  while (state.commandQueue.length > 0) {
    const item = state.commandQueue.shift();
    await executeCommand(item.command, item.source);
  }

  state.queueRunning = false;
  maybeContinueAgent();
}

async function executeCommand(command, source) {
  if (source === "agent" && command.type !== "batchEnd") {
    rememberAgentCommand(command);
  }

  if (command.type === "setColor") {
    setColor(command.color);
    return;
  }

  if (command.type === "setBrush") {
    setBrush(command.size);
    return;
  }

  if (command.type === "batchEnd") {
    state.continueRequested = command.continue;
    if (command.note) logEvent(`batch: ${command.note}`);
    return;
  }

  if (source === "agent") {
    saveUndo();
  }

  if (command.type === "stroke") {
    await animateStroke(command.points);
  } else if (command.type === "line") {
    await animateLine(command.x1, command.y1, command.x2, command.y2);
  } else if (command.type === "rect") {
    drawRect(command.x, command.y, command.w, command.h, command.fill);
    await delay(90);
  } else if (command.type === "ellipse") {
    drawEllipse(command.x, command.y, command.rx, command.ry, command.fill);
    await delay(90);
  } else if (command.type === "circle") {
    drawEllipse(command.x, command.y, command.r, command.r, command.fill);
    await delay(90);
  } else if (command.type === "fill") {
    floodFill(command.x, command.y, hexToRgba(state.color));
    await delay(90);
  } else if (command.type === "text") {
    drawText(command.x, command.y, command.text, command.size);
    await delay(90);
  } else if (command.type === "undo") {
    undo(command.count);
    await delay(90);
  }
}

async function animateStroke(points) {
  for (let index = 1; index < points.length; index += 1) {
    const from = { x: points[index - 1][0], y: points[index - 1][1] };
    const to = { x: points[index][0], y: points[index][1] };
    drawSegment(ctx, from, to, { color: state.color, size: state.brushSize });
    await delay(12);
  }
}

async function animateLine(x1, y1, x2, y2) {
  const steps = 18;
  let previous = { x: x1, y: y1 };
  for (let step = 1; step <= steps; step += 1) {
    const next = {
      x: x1 + ((x2 - x1) * step) / steps,
      y: y1 + ((y2 - y1) * step) / steps,
    };
    drawSegment(ctx, previous, next, { color: state.color, size: state.brushSize });
    previous = next;
    await delay(10);
  }
}

function sanitizeClientCommand(raw) {
  if (!raw || typeof raw !== "object") return null;
  const type = String(raw.type || "");

  if (type === "setColor") {
    const color = normalizeHex(raw.color);
    return color ? { type, color } : null;
  }

  if (type === "setBrush") {
    return { type, size: clampInt(raw.size, 1, 60, 4) };
  }

  if (type === "stroke" && Array.isArray(raw.points) && raw.points.length >= 2) {
    return {
      type,
      points: raw.points.slice(0, 160).map((point) => [
        clampNumber(point?.[0], 0, canvas.width, 0),
        clampNumber(point?.[1], 0, canvas.height, 0),
      ]),
    };
  }

  if (type === "line") {
    return {
      type,
      x1: clampNumber(raw.x1, 0, canvas.width, 0),
      y1: clampNumber(raw.y1, 0, canvas.height, 0),
      x2: clampNumber(raw.x2, 0, canvas.width, 0),
      y2: clampNumber(raw.y2, 0, canvas.height, 0),
    };
  }

  if (type === "rect") {
    const rect = normalizeRect(raw.x, raw.y, raw.w, raw.h);
    return { type, ...rect, fill: Boolean(raw.fill) };
  }

  if (type === "ellipse") {
    return {
      type,
      x: clampNumber(raw.x, 0, canvas.width, canvas.width / 2),
      y: clampNumber(raw.y, 0, canvas.height, canvas.height / 2),
      rx: clampNumber(raw.rx, 1, canvas.width / 2, 20),
      ry: clampNumber(raw.ry, 1, canvas.height / 2, 20),
      fill: Boolean(raw.fill),
    };
  }

  if (type === "circle") {
    return {
      type,
      x: clampNumber(raw.x, 0, canvas.width, canvas.width / 2),
      y: clampNumber(raw.y, 0, canvas.height, canvas.height / 2),
      r: clampNumber(raw.r, 1, Math.min(canvas.width, canvas.height) / 2, 20),
      fill: Boolean(raw.fill),
    };
  }

  if (type === "fill") {
    return {
      type,
      x: clampInt(raw.x, 0, canvas.width - 1, 0),
      y: clampInt(raw.y, 0, canvas.height - 1, 0),
    };
  }

  if (type === "text") {
    return {
      type,
      x: clampNumber(raw.x, 0, canvas.width, 0),
      y: clampNumber(raw.y, 0, canvas.height, 0),
      text: String(raw.text || "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80),
      size: clampInt(raw.size, 8, 96, 22),
    };
  }

  if (type === "undo") {
    return { type, count: clampInt(raw.count, 1, 8, 1) };
  }

  if (type === "batchEnd") {
    return {
      type,
      continue: Boolean(raw.continue),
      note: String(raw.note || "").slice(0, 160),
    };
  }

  return null;
}

function normalizeRect(x, y, w, h) {
  let left = clampNumber(x, -canvas.width, canvas.width, 0);
  let top = clampNumber(y, -canvas.height, canvas.height, 0);
  let width = clampNumber(w, -canvas.width, canvas.width, 10);
  let height = clampNumber(h, -canvas.height, canvas.height, 10);

  if (width < 0) {
    left += width;
    width = Math.abs(width);
  }
  if (height < 0) {
    top += height;
    height = Math.abs(height);
  }

  left = clampNumber(left, 0, canvas.width, 0);
  top = clampNumber(top, 0, canvas.height, 0);

  return {
    x: left,
    y: top,
    w: clampNumber(width, 1, canvas.width - left, 1),
    h: clampNumber(height, 1, canvas.height - top, 1),
  };
}

async function startAgent() {
  await ensureSocket();
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;

  const hasExistingSession = state.agentSessionStarted && state.agentActionHistory.length > 0;
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
      recentActions: state.recentAgentActions,
      historyActions: state.agentActionHistory,
      promptHistory: state.promptHistory,
      turnBudget: getTurnBudgetPayload(),
    }),
  );

  state.recentAgentActions = [];
}

async function sendFeedbackStep({ userInitiated = false } = {}) {
  await ensureSocket();
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN || state.modelStreaming) return;

  state.agentRunning = true;
  state.agentSessionStarted = true;
  state.currentTurn = Math.max(0, state.currentTurn);
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
      recentActions: state.recentAgentActions,
      historyActions: state.agentActionHistory,
      promptHistory: state.promptHistory,
      turnBudget: getTurnBudgetPayload(),
    }),
  );

  state.recentAgentActions = [];
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
  state.recentAgentActions = [];
  state.agentActionHistory = [];
  state.promptHistory = [];
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
    if (!llamaUrl.value) llamaUrl.value = message.apiBaseUrl || message.llamaServerUrl || "";
    if (!chatPath.value) chatPath.value = message.chatPath || message.llamaChatPath || "";
    if (!modelName.value) modelName.value = message.model || "";
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
    logEvent(`model start: ${message.providerLabel || message.provider || "provider"} ${message.endpoint}`);
    if (message.sampling) {
      logEvent(
        `sampling: temp=${message.sampling.temperature}, top_p=${message.sampling.topP}, top_k=${message.sampling.topK}, min_p=${message.sampling.minP}`,
      );
    }
    if (message.usingVision) logEvent("vision feedback included");
    return;
  }

  if (message.type === "agentCommand") {
    const command = sanitizeClientCommand(message.command);
    if (!command) {
      logEvent("ignored invalid command from server", "warn");
      return;
    }
    logEvent(JSON.stringify(command), "command");
    enqueueCommand(command, "agent");
    return;
  }

  if (message.type === "modelText") {
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
    state.noProgressTurns = message.commandsThisTurn > 0 ? 0 : state.noProgressTurns + 1;
    setStatus(
      message.aborted
        ? "Stopped"
        : `Turn ${message.turn} done: ${message.commandsThisTurn} commands`,
    );
    logEvent(`model done: ${message.commandsThisTurn} commands`);
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
    apiBaseUrl: llamaUrl.value.trim(),
    chatPath: chatPath.value.trim(),
    llamaServerUrl: llamaUrl.value.trim(),
    llamaChatPath: chatPath.value.trim(),
    model: modelName.value.trim(),
    apiKey: apiKeyInput.value.trim(),
    temperature: blankNewPrompt ? sampling.temperature : 0.65,
    maxTokens: 1400,
    seed: blankNewPrompt ? randomSeed() : null,
    ...sampling,
  };
}

function getCreativeSamplingConfig(creativity) {
  const value = clampNumber(creativity, 0, 100, 82) / 100;

  return {
    temperature: roundTo(0.85 + value * 0.7, 2),
    topP: roundTo(0.9 + value * 0.09, 3),
    topK: clampInt(40 + value * 180, 40, 220, 188),
    minP: roundTo(0.045 - value * 0.035, 3),
    repeatPenalty: roundTo(1 + value * 0.1, 3),
    presencePenalty: roundTo(value * 0.45, 3),
    frequencyPenalty: roundTo(value * 0.25, 3),
    xtcProbability: roundTo(value * 0.35, 3),
    xtcThreshold: 0.1,
    dynatempRange: roundTo(value * 0.25, 3),
    dynatempExponent: 1,
  };
}

async function captureCanvasFeedback(includeImage = false) {
  const stats = summarizeCanvas();
  const payload = {
    width: canvas.width,
    height: canvas.height,
    stats,
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

      const key = [
        Math.round(r / 32) * 32,
        Math.round(g / 32) * 32,
        Math.round(b / 32) * 32,
      ].join(",");
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
    image.addEventListener("error", () => reject(new Error("Could not load reference image.")));
    image.src = src;
  });
}

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

function rememberAgentCommand(command) {
  const snapshot = structuredClone(command);
  state.recentAgentActions.push(snapshot);
  state.agentActionHistory.push(snapshot);

  if (state.recentAgentActions.length > COMMAND_LOG_LIMIT) {
    state.recentAgentActions.shift();
  }
  if (state.agentActionHistory.length > AGENT_HISTORY_LIMIT) {
    state.agentActionHistory.shift();
  }
}

function rememberPrompt(prompt, mode) {
  const text = prompt || "(agent chose subject)";
  state.promptHistory.push({
    mode,
    turn: state.currentTurn,
    prompt: text.slice(0, 240),
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
  return `${Date.now().toString(36)}-${[...values]
    .map((value) => value.toString(36))
    .join("-")}`;
}
