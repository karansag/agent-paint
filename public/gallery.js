const grid = document.querySelector("#galleryGrid");
const status = document.querySelector("#galleryStatus");

loadGallery();

async function loadGallery() {
  try {
    const response = await fetch("/api/gallery", { cache: "no-store" });
    if (!response.ok) throw new Error(`Gallery request returned ${response.status}`);
    const payload = await response.json();
    renderGallery(Array.isArray(payload.images) ? payload.images : []);
  } catch (error) {
    grid.replaceChildren();
    status.textContent = "Gallery unavailable.";
    console.error(error);
  }
}

function renderGallery(images) {
  grid.replaceChildren();

  if (images.length === 0) {
    status.textContent = "No gallery images yet.";
    return;
  }

  status.textContent = `${images.length} image${images.length === 1 ? "" : "s"}`;
  for (const image of images) {
    const card = document.createElement("article");
    card.className = "gallery-card";

    const link = document.createElement("a");
    link.href = image.url;
    link.target = "_blank";
    link.rel = "noreferrer";

    const img = document.createElement("img");
    img.src = image.url;
    img.alt = image.name;
    img.loading = "lazy";

    const caption = document.createElement("div");
    caption.className = "gallery-caption";
    caption.textContent = image.name;

    link.append(img);
    card.append(link, caption, createMetadataBlock(image.metadata || {}));
    grid.append(card);
  }
}

function createMetadataBlock(metadata) {
  const block = document.createElement("dl");
  block.className = "gallery-metadata";

  const rows = [
    ["Model", metadata.model || "Unknown"],
    ["Turns", metadata.turns === 0 || metadata.turns ? String(metadata.turns) : "Unknown"],
    ["Prompt", metadata.prompt ? metadata.prompt : "(empty prompt)"],
  ];
  if (metadata.provider) rows.splice(1, 0, ["Provider", metadata.provider]);

  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    block.append(dt, dd);
  }

  return block;
}
