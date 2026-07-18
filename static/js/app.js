"use strict";

/* Likes are only remembered for the current page view (this Set), never
   persisted client-side — a reload always starts unliked again, per spec.
   The aggregate like_count in the database is what the stats page reads. */
const likedThisView = new Set();

const ICON_HEART =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>';
const ICON_TRASH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>';
const ICON_CHEVRON_LEFT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>';
const ICON_CHEVRON_RIGHT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';
const ICON_IMAGE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>';

function setupThemeToggle() {
  const btn = document.getElementById("themeBtn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const current =
      document.documentElement.getAttribute("data-theme") ||
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
  });
}

function showSnackbar(message) {
  const el = document.getElementById("snackbar");
  if (!el) return;
  el.textContent = message;
  el.classList.add("visible");
  clearTimeout(showSnackbar._t);
  showSnackbar._t = setTimeout(() => el.classList.remove("visible"), 3200);
}

/* ---------------- Feed page ---------------- */

function initFeedPage() {
  setupThemeToggle();
  loadFeed();

  document.getElementById("shuffleBtn").addEventListener("click", loadFeed);

  const fab = document.getElementById("uploadFab");
  const fileInput = document.getElementById("fileInput");
  fab.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    uploadFiles(Array.from(fileInput.files));
    fileInput.value = "";
  });

  let dragDepth = 0;
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragDepth++;
    document.body.classList.add("dropzone-active");
  });
  document.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove("dropzone-active");
  });
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove("dropzone-active");
    const files = Array.from(e.dataTransfer.files || []).filter((f) =>
      f.type.startsWith("image/")
    );
    if (files.length) uploadFiles(files);
  });
}

async function loadFeed() {
  const feed = document.getElementById("feed");
  feed.innerHTML = '<div class="spinner"></div>';
  likedThisView.clear();

  const res = await fetch("/api/feed");
  const data = await res.json();

  if (!data.posts.length) {
    feed.innerHTML =
      '<div class="empty-state">' +
      ICON_IMAGE +
      "<div>Noch keine Bilder. Lade welche hoch, um loszulegen.</div></div>";
    return;
  }

  feed.innerHTML = "";
  data.posts.forEach((post) => feed.appendChild(renderPost(post)));
}

function renderPost(images) {
  const post = document.createElement("article");
  post.className = "post";

  const wrap = document.createElement("div");
  wrap.className = "carousel-wrap";

  const ratio = clampRatio(images[0].width / images[0].height);
  wrap.style.aspectRatio = ratio;

  const carousel = document.createElement("div");
  carousel.className = "carousel";

  images.forEach((img) => carousel.appendChild(renderSlide(img)));
  wrap.appendChild(carousel);

  if (images.length > 1) {
    const dots = document.createElement("div");
    dots.className = "dots";
    images.forEach((_, i) => {
      const d = document.createElement("span");
      d.className = "dot" + (i === 0 ? " active" : "");
      dots.appendChild(d);
    });
    wrap.appendChild(dots);

    const prev = document.createElement("button");
    prev.className = "carousel-nav prev";
    prev.innerHTML = ICON_CHEVRON_LEFT;
    prev.addEventListener("click", () => carousel.scrollBy({ left: -carousel.clientWidth, behavior: "smooth" }));

    const next = document.createElement("button");
    next.className = "carousel-nav next";
    next.innerHTML = ICON_CHEVRON_RIGHT;
    next.addEventListener("click", () => carousel.scrollBy({ left: carousel.clientWidth, behavior: "smooth" }));

    wrap.appendChild(prev);
    wrap.appendChild(next);

    let ticking = false;
    carousel.addEventListener("scroll", () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const idx = Math.round(carousel.scrollLeft / carousel.clientWidth);
        [...dots.children].forEach((d, i) => d.classList.toggle("active", i === idx));
        ticking = false;
      });
    });
  }

  post.appendChild(wrap);
  return post;
}

function clampRatio(r) {
  if (!r || Number.isNaN(r)) return 1;
  return Math.min(1.91, Math.max(0.8, r));
}

function renderSlide(img) {
  const slide = document.createElement("div");
  slide.className = "slide";
  slide.dataset.imageId = img.id;

  const image = document.createElement("img");
  image.src = img.url;
  image.loading = "lazy";
  image.alt = "";
  slide.appendChild(image);

  const actions = document.createElement("div");
  actions.className = "slide-actions";

  const likeBtn = document.createElement("button");
  likeBtn.className = "pill-btn like-btn";
  const countSpan = document.createElement("span");
  countSpan.textContent = img.like_count;
  likeBtn.innerHTML = ICON_HEART;
  likeBtn.appendChild(countSpan);
  likeBtn.addEventListener("click", () => toggleLike(img.id, likeBtn, countSpan));

  const delBtn = document.createElement("button");
  delBtn.className = "pill-btn delete-btn";
  delBtn.innerHTML = ICON_TRASH;
  delBtn.title = "Für immer löschen";
  delBtn.addEventListener("click", () => deleteImage(img.id, slide, slide.closest(".post")));

  actions.appendChild(likeBtn);
  actions.appendChild(delBtn);
  slide.appendChild(actions);

  return slide;
}

async function toggleLike(imageId, btn, countSpan) {
  const isLiked = likedThisView.has(imageId);
  btn.classList.toggle("liked", !isLiked);
  const endpoint = isLiked ? "unlike" : "like";

  try {
    const res = await fetch(`/api/${endpoint}/${imageId}`, { method: "POST" });
    const data = await res.json();
    if (typeof data.like_count === "number") countSpan.textContent = data.like_count;
    if (isLiked) {
      likedThisView.delete(imageId);
    } else {
      likedThisView.add(imageId);
      btn.classList.add("liked");
      setTimeout(() => btn.classList.remove("liked"), 260);
    }
  } catch (err) {
    btn.classList.toggle("liked", isLiked);
  }
}

async function deleteImage(imageId, slideEl, postEl) {
  if (!confirm("Dieses Bild endgültig löschen?")) return;

  try {
    const res = await fetch(`/api/image/${imageId}`, { method: "DELETE" });
    if (!res.ok) throw new Error("delete failed");
  } catch (err) {
    showSnackbar("Löschen fehlgeschlagen.");
    return;
  }

  const carousel = postEl.querySelector(".carousel");
  const remaining = carousel.querySelectorAll(".slide").length - 1;
  slideEl.remove();

  if (remaining <= 0) {
    postEl.remove();
    if (!document.querySelectorAll(".post").length) {
      document.getElementById("feed").innerHTML =
        '<div class="empty-state">' +
        ICON_IMAGE +
        "<div>Noch keine Bilder. Lade welche hoch, um loszulegen.</div></div>";
    }
  } else {
    const dots = postEl.querySelectorAll(".dot");
    if (remaining <= 1) {
      const dotsWrap = postEl.querySelector(".dots");
      if (dotsWrap) dotsWrap.remove();
      postEl.querySelectorAll(".carousel-nav").forEach((n) => n.remove());
    } else if (dots.length) {
      dots[dots.length - 1].remove();
    }
  }
}

/* ---------------- Upload ---------------- */

const UPLOAD_BATCH_SIZE = 12;

async function uploadFiles(files) {
  const images = files.filter((f) => f.type.startsWith("image/"));
  if (!images.length) return;

  const progressWrap = document.getElementById("progressWrap");
  const progressBar = document.getElementById("progressBar");
  const progressLabel = document.getElementById("progressLabel");
  progressWrap.classList.add("visible");
  progressBar.style.width = "0%";

  let processed = 0;
  let uploaded = 0;
  let duplicates = 0;
  let errors = 0;

  for (let i = 0; i < images.length; i += UPLOAD_BATCH_SIZE) {
    const batch = images.slice(i, i + UPLOAD_BATCH_SIZE);
    const form = new FormData();
    batch.forEach((f) => form.append("files", f));

    try {
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = await res.json();
      uploaded += data.uploaded || 0;
      duplicates += data.duplicates || 0;
      errors += (data.errors || []).length;
    } catch (err) {
      errors += batch.length;
    }

    processed += batch.length;
    const pct = Math.round((processed / images.length) * 100);
    progressBar.style.width = pct + "%";
    progressLabel.textContent = `Hochladen… ${processed} / ${images.length}`;
  }

  setTimeout(() => progressWrap.classList.remove("visible"), 500);

  const parts = [`${uploaded} hochgeladen`];
  if (duplicates) parts.push(`${duplicates} Duplikate übersprungen`);
  if (errors) parts.push(`${errors} fehlgeschlagen`);
  showSnackbar(parts.join(" · "));

  if (uploaded) loadFeed();
}

/* ---------------- Stats page ---------------- */

async function initStatsPage() {
  setupThemeToggle();
  const grid = document.getElementById("statsGrid");
  grid.innerHTML = '<div class="spinner"></div>';

  const res = await fetch("/api/stats");
  const items = await res.json();

  if (!items.length) {
    grid.innerHTML =
      '<div class="empty-state">' + ICON_IMAGE + "<div>Noch keine Statistik vorhanden.</div></div>";
    return;
  }

  grid.innerHTML = "";
  items.forEach((item, i) => {
    const tile = document.createElement("div");
    tile.className = "stat-tile";
    tile.innerHTML = `
      <img src="${item.url}" loading="lazy" alt="" />
      <span class="stat-rank">${i + 1}</span>
      <span class="stat-likes">${ICON_HEART}${item.like_count}</span>
    `;
    grid.appendChild(tile);
  });
}
