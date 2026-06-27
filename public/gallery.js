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

    const caption = document.createElement("span");
    caption.textContent = image.name;

    link.append(img, caption);
    card.append(link);
    grid.append(card);
  }
}
