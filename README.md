# Agent Paint

MS Paint style canvas with an agent loop for any OpenAI-compatible chat API.

The model draws by streaming **raw SVG**. Each complete element (`<path>`, `<circle>`, `<g>`, gradients, `<text>`, ...) is painted onto the canvas the moment its closing tag arrives, so the drawing builds up live. After each batch the browser can send a downscaled canvas screenshot and a compact visual summary back to the model, so the agent can continue or correct its work.

Giving the model SVG instead of a fixed set of paint primitives means it can draw anything it can describe — Bezier curves, gradients, transforms, opacity — and its own taste shows through. The system prompt tells the model who it is and explicitly asks for its own style.

## Run

```bash
npm install
npm start       # http://localhost:5173
npm test        # unit tests for the SVG stream parser and provider config
```

By default the backend probes local `llama-server` ports (`8081`, then `8080`) and uses the first healthy endpoint — so a local Gemma served by llama.cpp works with zero config.

Environment overrides:

```bash
LLM_PROVIDER=llama LLM_BASE_URL=http://127.0.0.1:8081 LLM_MODEL=gemma-4-26B-A4B-it-Q4_K_M.gguf npm start
OPENAI_API_KEY=...    LLM_PROVIDER=openai npm start
ANTHROPIC_API_KEY=... LLM_PROVIDER=anthropic npm start
```

Recognized variables: `PORT`, `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_MODEL`, `LLM_CHAT_PATH`, `LLM_MAX_TOKENS`, and the per-provider key vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `LLAMA_API_KEY`, or generic `LLM_API_KEY`). Everything can also be changed in the UI per request.

## Providers

- **Local llama.cpp** — `http://127.0.0.1:8081/v1/chat/completions`; vision support is probed via `/props`, model name via `/v1/models`
- **OpenAI** — `https://api.openai.com/v1/chat/completions`
- **Claude** — Anthropic's OpenAI-compatible endpoint, `https://api.anthropic.com/v1/chat/completions` (default model `claude-opus-4-8`)
- **Custom OpenAI-compatible** — any base URL / path / model

The model field is a dropdown populated live from the provider (`/v1/models` for llama.cpp/OpenAI/custom, the native models API for Anthropic), with a `Custom...` option for typing an arbitrary model id. The list refreshes when you change provider, base URL, or API key.

The UI does not expose sampling controls. Hosted OpenAI and Anthropic requests do not include `temperature`, `top_p`, `top_k`, or `min_p`.

## Drawing protocol

The model is prompted to stream SVG elements, nothing else:

```xml
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#0ea5e9"/><stop offset="1" stop-color="#f8fafc"/>
</linearGradient></defs>
<rect x="0" y="0" width="768" height="512" fill="url(#sky)"/>
<path d="M0 380 C 180 300, 420 340, 768 290 L 768 512 L 0 512 Z" fill="#16a34a"/>
<batch continue="true" note="add the lighthouse next"/>
```

- Allowed elements: `path rect circle ellipse line polyline polygon text tspan g defs use symbol linearGradient radialGradient stop`
- An `<svg>` wrapper, comments, markdown fences, and prose are tolerated and ignored
- `<batch continue="true|false" note="..."/>` ends a batch and drives the auto feedback loop
- Gradients and symbols persist for the rest of the session, so later elements can reference them
- The server screens elements (tag allowlist, no event handlers, no `javascript:`), and the browser re-sanitizes with a real XML parser before painting; the canvas is never tainted, so PNG export keeps working

## Iteration

**Send** starts a drawing or, once one exists, sends an edit request (the model is told to preserve the canvas). **Stop** aborts the active run. **New** clears the canvas and the agent's memory.

For blank prompts the model chooses its own subject. The app does not inject subject suggestions.

The **Random** button beside the prompt asks the selected provider/model for one drawing prompt and inserts it into the prompt box.

## Gallery

The gallery page is available at `/gallery`. Add exported images to `public/gallery/` and commit them; when the Node server runs, `/api/gallery` scans that folder and the page displays the images.

Export is browser-side. The app creates a PNG download in your browser, so files land wherever that browser is configured to save downloads. The server does not automatically write exported images into the repo.
