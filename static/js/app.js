"use strict";

/* Likes are only remembered for the current page view (this Set), never
   persisted client-side — a reload always starts unliked again, per spec.
   The aggregate like_count in the database is what the stats page reads. */
const likedThisView = new Set();

/* Posts from the last /api/feed call. Both the normal feed and the TikTok
   view render from this same array so they always agree on what a "post" is;
   only the layout differs. */
let currentPosts = [];
let tiktokBuilt = false;

const ICON_HEART =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>';
const ICON_HEART_FILLED =
  '<svg viewBox="0 0 24 24"><path d="M12 21s-6.7-4.35-9.3-8.1C1 10.1 1.6 6.9 4.2 5.3c2.2-1.4 5-.8 6.6 1.1l1.2 1.4 1.2-1.4c1.6-1.9 4.4-2.5 6.6-1.1 2.6 1.6 3.2 4.8 1.5 7.6C18.7 16.65 12 21 12 21z" fill="currentColor"/></svg>';
const ICON_TRASH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>';
const ICON_CHEVRON_LEFT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>';
const ICON_CHEVRON_RIGHT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';
const ICON_IMAGE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>';

document.addEventListener("contextmenu", (e) => e.preventDefault());

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

/* Body scroll is locked whenever the privacy shield or the TikTok overlay
   is showing - both toggle through here so neither one clobbers the other. */
function updateBodyScrollLock() {
  const shield = document.getElementById("privacyShield");
  const tiktok = document.getElementById("tiktokView");
  const locked = (shield && !shield.hidden) || (tiktok && !tiktok.hidden);
  document.body.style.overflow = locked ? "hidden" : "";
}

/* Blur the whole page on first load and again every time the tab/screen
   becomes visible after being hidden (backgrounded, screen off, tab
   switch) - a quick "for safety" shield before the feed is shown. */
function setupPrivacyShield() {
  const shield = document.getElementById("privacyShield");
  const btn = document.getElementById("continueBtn");
  if (!shield || !btn) return;

  function show() {
    shield.hidden = false;
    updateBodyScrollLock();
  }
  function hide() {
    shield.hidden = true;
    updateBodyScrollLock();
  }

  show();
  btn.addEventListener("click", hide);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) show();
  });
}

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

function emptyStateHTML(message) {
  return (
    '<div class="empty-state">' + ICON_IMAGE + `<div>${message}</div></div>`
  );
}

/* ---------------- Feed page ---------------- */

function initFeedPage() {
  setupPrivacyShield();
  setupThemeToggle();
  setupTiktokMode();
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

  try {
    const res = await fetch("/api/feed");
    if (!res.ok) throw new Error("Feed request failed");
    const data = await res.json();
    currentPosts = data.posts;
    tiktokBuilt = false;

    if (!currentPosts.length) {
      feed.innerHTML = emptyStateHTML("Noch keine Bilder. Lade welche hoch, um loszulegen.");
      return;
    }

    feed.innerHTML = "";
    currentPosts.forEach((post) => feed.appendChild(renderPost(post)));
  } catch (err) {
    feed.innerHTML = emptyStateHTML("Fehler beim Laden des Feeds. Bitte lade die Seite neu.");
    showSnackbar("Fehler beim Laden des Feeds.");
  }
}

/* Shared by the normal feed and the TikTok view: builds the swipeable
   carousel (images + dots + prev/next) that a post is made of.

   Paging is JS-driven (transform: translateX), same approach as the
   TikTok view's vertical pager and for the same reason: native scroll-snap
   momentum can carry a hard swipe past more than one slide. A touch drag
   still follows the finger live, but on release it can only ever land on
   the adjacent slide. */
function buildCarouselWrap(images) {
  const wrap = document.createElement("div");
  wrap.className = "carousel-wrap";

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

    const pager = createHSwipePager(wrap, carousel, images.length, (idx) => {
      [...dots.children].forEach((d, i) => d.classList.toggle("active", i === idx));
    });

    const prev = document.createElement("button");
    prev.className = "carousel-nav prev";
    prev.innerHTML = ICON_CHEVRON_LEFT;
    prev.addEventListener("click", () => pager.goTo(pager.index - 1));

    const next = document.createElement("button");
    next.className = "carousel-nav next";
    next.innerHTML = ICON_CHEVRON_RIGHT;
    next.addEventListener("click", () => pager.goTo(pager.index + 1));

    wrap.appendChild(prev);
    wrap.appendChild(next);
  }

  return wrap;
}

/* One instance per carousel (a page can have many at once, e.g. the whole
   feed) - unlike the single global TikTok pager, this keeps its state in a
   closure rather than a shared object. */
function createHSwipePager(wrap, track, count, onIndexChange) {
  const state = { index: 0, transitioning: false };

  function goTo(newIndex, animate = true) {
    newIndex = Math.max(0, Math.min(count - 1, newIndex));
    state.index = newIndex;
    const offset = newIndex * wrap.clientWidth;
    track.style.willChange = "transform";
    track.style.transition = animate ? "transform 0.32s cubic-bezier(.22,.61,.36,1)" : "none";
    track.style.transform = `translateX(-${offset}px)`;
    if (animate) {
      state.transitioning = true;
      track.addEventListener(
        "transitionend",
        () => {
          state.transitioning = false;
          track.style.willChange = "auto";
        },
        { once: true }
      );
    } else {
      track.style.willChange = "auto";
    }
    onIndexChange(newIndex);
  }

  let startX = 0;
  let startY = 0;
  let dragDelta = 0;
  let axis = null;
  let dragging = false;

  wrap.addEventListener(
    "touchstart",
    (e) => {
      if (state.transitioning) return;
      dragging = true;
      axis = null;
      dragDelta = 0;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    },
    { passive: true }
  );

  wrap.addEventListener(
    "touchmove",
    (e) => {
      if (!dragging) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;

      if (!axis) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
        if (axis === "x") {
          track.style.transition = "none";
          track.style.willChange = "transform";
        }
      }
      if (axis !== "x") return; // vertical: let the page (or the TikTok pager) handle it

      e.preventDefault();
      dragDelta = dx;
      if ((state.index === 0 && dragDelta > 0) || (state.index === count - 1 && dragDelta < 0)) {
        dragDelta *= 0.35; // rubber-band at the first/last image
      }
      const base = state.index * wrap.clientWidth;
      track.style.transform = `translateX(${-base + dragDelta}px)`;
    },
    { passive: false }
  );

  wrap.addEventListener("touchend", () => {
    if (!dragging) return;
    dragging = false;
    if (axis !== "x") {
      axis = null;
      return;
    }

    const threshold = wrap.clientWidth * 0.18;
    if (dragDelta <= -threshold) goTo(state.index + 1);
    else if (dragDelta >= threshold) goTo(state.index - 1);
    else goTo(state.index);
    axis = null;
    dragDelta = 0;
  });

  window.addEventListener("resize", () => goTo(state.index, false));

  return {
    goTo,
    get index() {
      return state.index;
    },
  };
}

function renderPost(images) {
  const post = document.createElement("article");
  post.className = "post";
  const wrap = buildCarouselWrap(images);
  wrap.style.aspectRatio = clampRatio(images[0].width / images[0].height);
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
  image.decoding = "async";
  image.alt = "";
  image.draggable = false;
  slide.appendChild(image);

  slide.addEventListener("dblclick", (e) => {
    e.preventDefault();
    handleDoubleTapLike(img.id, slide);
  });

  slide.appendChild(buildActions(img.id, img.like_count));

  return slide;
}

function buildActions(imageId, likeCount) {
  const actions = document.createElement("div");
  actions.className = "slide-actions";

  const likeBtn = document.createElement("button");
  likeBtn.className = "pill-btn like-btn";
  likeBtn.classList.toggle("liked", likedThisView.has(imageId));
  const countSpan = document.createElement("span");
  countSpan.textContent = likeCount;
  likeBtn.innerHTML = ICON_HEART;
  likeBtn.appendChild(countSpan);
  likeBtn.addEventListener("click", () => toggleLike(imageId));

  const delBtn = document.createElement("button");
  delBtn.className = "pill-btn delete-btn";
  delBtn.innerHTML = ICON_TRASH;
  delBtn.title = "Für immer löschen";
  delBtn.addEventListener("click", () => deleteImage(imageId));

  actions.appendChild(likeBtn);
  actions.appendChild(delBtn);
  return actions;
}

/* ---------------- Likes ---------------- */

async function toggleLike(imageId) {
  const isLiked = likedThisView.has(imageId);
  const endpoint = isLiked ? "unlike" : "like";

  try {
    const res = await fetch(`/api/${endpoint}/${imageId}`, { method: "POST" });
    const data = await res.json();
    const nowLiked = !isLiked;
    if (nowLiked) likedThisView.add(imageId);
    else likedThisView.delete(imageId);
    if (typeof data.like_count === "number") {
      applyLikeState(imageId, data.like_count, nowLiked);
      updateStoredLikeCount(imageId, data.like_count);
    }
  } catch (err) {
    showSnackbar("Aktion fehlgeschlagen.");
  }
}

/* Double-tap/double-click only ever likes (never unlikes), same as Instagram. */
async function handleDoubleTapLike(imageId, slideEl) {
  burstHeart(slideEl);
  if (likedThisView.has(imageId)) return;

  try {
    const res = await fetch(`/api/like/${imageId}`, { method: "POST" });
    const data = await res.json();
    likedThisView.add(imageId);
    if (typeof data.like_count === "number") {
      applyLikeState(imageId, data.like_count, true);
      updateStoredLikeCount(imageId, data.like_count);
    }
  } catch (err) {
    /* the burst animation already gave feedback; a failed sync isn't worth a snackbar */
  }
}

/* An image can appear once in the normal feed and once in the TikTok view -
   keep both in sync without re-fetching. */
function applyLikeState(imageId, likeCount, liked) {
  document.querySelectorAll(`.slide[data-image-id="${imageId}"] .like-btn`).forEach((btn) => {
    btn.classList.toggle("liked", liked);
    const span = btn.querySelector("span");
    if (span) span.textContent = likeCount;
  });
}

function updateStoredLikeCount(imageId, likeCount) {
  currentPosts.forEach((post) => {
    post.forEach((img) => {
      if (img.id === imageId) img.like_count = likeCount;
    });
  });
}

function burstHeart(slideEl) {
  const heart = document.createElement("div");
  heart.className = "heart-burst";
  heart.innerHTML = ICON_HEART_FILLED;
  slideEl.appendChild(heart);
  heart.addEventListener("animationend", () => heart.remove());
}

/* ---------------- Delete ---------------- */

async function deleteImage(imageId) {
  if (!confirm("Dieses Bild endgültig löschen?")) return;

  try {
    const res = await fetch(`/api/image/${imageId}`, { method: "DELETE" });
    if (!res.ok) throw new Error("delete failed");
  } catch (err) {
    showSnackbar("Löschen fehlgeschlagen.");
    return;
  }

  document
    .querySelectorAll(`.slide[data-image-id="${imageId}"]`)
    .forEach((slideEl) => removeSlideElement(slideEl));

  currentPosts = currentPosts
    .map((post) => post.filter((img) => img.id !== imageId))
    .filter((post) => post.length > 0);

  pruneEmptyViews();
  tiktokRealign();
}

function removeSlideElement(slideEl) {
  const container = slideEl.closest(".post, .tiktok-post");
  const carousel = container.querySelector(".carousel");
  const remaining = carousel.querySelectorAll(".slide").length - 1;
  slideEl.remove();

  if (remaining <= 0) {
    container.remove();
    return;
  }

  if (remaining <= 1) {
    const dotsWrap = container.querySelector(".dots");
    if (dotsWrap) dotsWrap.remove();
    container.querySelectorAll(".carousel-nav").forEach((n) => n.remove());
  } else {
    const dots = container.querySelectorAll(".dot");
    if (dots.length) dots[dots.length - 1].remove();
  }
}

function pruneEmptyViews() {
  const feed = document.getElementById("feed");
  if (feed && !feed.querySelector(".post")) {
    feed.innerHTML = emptyStateHTML("Noch keine Bilder. Lade welche hoch, um loszulegen.");
  }
  const tiktokTrack = document.getElementById("tiktokTrack");
  if (tiktokTrack && tiktokBuilt && !tiktokTrack.querySelector(".tiktok-post")) {
    tiktokTrack.innerHTML = emptyStateHTML("Keine Bilder mehr.");
  }
}

/* ---------------- TikTok mode ----------------
   Paging is driven entirely by JS (transform: translateY on a track),
   never native scroll momentum - that's what guarantees exactly one post
   moves per swipe/wheel gesture, no matter how hard or fast it is. A touch
   drag still follows the finger live (with a rubber-band edge) for a
   natural feel, but on release it can only ever land on index ± 1. */

const tiktokPager = {
  feed: null,
  track: null,
  index: 0,
  transitioning: false,
  wheelLocked: false,
};

function setupTiktokMode() {
  const openBtn = document.getElementById("tiktokBtn");
  const exitBtn = document.getElementById("tiktokExitBtn");
  const overlay = document.getElementById("tiktokView");
  tiktokPager.feed = document.getElementById("tiktokFeed");
  tiktokPager.track = document.getElementById("tiktokTrack");
  if (!openBtn || !overlay || !tiktokPager.track) return;

  openBtn.addEventListener("click", () => {
    if (!currentPosts.length) {
      showSnackbar("Noch keine Bilder für den vertikalen Modus.");
      return;
    }
    if (!tiktokBuilt) buildTiktokView();
    overlay.hidden = false;
    updateBodyScrollLock();
  });

  exitBtn.addEventListener("click", () => {
    overlay.hidden = true;
    updateBodyScrollLock();
  });

  attachTiktokGestures();
}

function buildTiktokView() {
  const track = tiktokPager.track;
  track.innerHTML = "";
  currentPosts.forEach((post) => track.appendChild(renderTiktokPost(post)));
  tiktokBuilt = true;
  tiktokGoTo(0, false);
}

function renderTiktokPost(images) {
  const post = document.createElement("article");
  post.className = "tiktok-post";
  post.appendChild(buildCarouselWrap(images));
  return post;
}

function tiktokItems() {
  return tiktokPager.track ? Array.from(tiktokPager.track.children) : [];
}

function tiktokGoTo(newIndex, animate = true) {
  const { feed, track } = tiktokPager;
  const list = tiktokItems();
  if (!list.length) return;

  newIndex = Math.max(0, Math.min(list.length - 1, newIndex));
  tiktokPager.index = newIndex;
  const offset = newIndex * feed.clientHeight;

  track.style.transition = animate ? "transform 0.42s cubic-bezier(.22,.61,.36,1)" : "none";
  track.style.transform = `translateY(-${offset}px)`;

  if (animate) {
    tiktokPager.transitioning = true;
    track.addEventListener(
      "transitionend",
      () => {
        tiktokPager.transitioning = false;
      },
      { once: true }
    );
  }
}

/* Called after a delete inside the TikTok view: the DOM may have lost a
   whole post, so re-apply the transform for the current index to whatever
   post now actually sits there. */
function tiktokRealign() {
  if (tiktokBuilt) tiktokGoTo(tiktokPager.index, false);
}

function attachTiktokGestures() {
  const { feed, track } = tiktokPager;

  feed.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (tiktokPager.wheelLocked || tiktokPager.transitioning) return;
      if (Math.abs(e.deltaY) < 8) return;
      tiktokPager.wheelLocked = true;
      tiktokGoTo(tiktokPager.index + (e.deltaY > 0 ? 1 : -1));
      setTimeout(() => {
        tiktokPager.wheelLocked = false;
      }, 480);
    },
    { passive: false }
  );

  let startX = 0;
  let startY = 0;
  let dragDelta = 0;
  let axis = null;
  let dragging = false;

  feed.addEventListener(
    "touchstart",
    (e) => {
      if (tiktokPager.transitioning) return;
      dragging = true;
      axis = null;
      dragDelta = 0;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    },
    { passive: true }
  );

  feed.addEventListener(
    "touchmove",
    (e) => {
      if (!dragging) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;

      if (!axis) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        axis = Math.abs(dy) > Math.abs(dx) ? "y" : "x";
        if (axis === "y") track.style.transition = "none";
      }
      if (axis !== "y") return; // horizontal: let the per-post image carousel handle it natively

      e.preventDefault();
      dragDelta = dy;
      const list = tiktokItems();
      if ((tiktokPager.index === 0 && dragDelta > 0) || (tiktokPager.index === list.length - 1 && dragDelta < 0)) {
        dragDelta *= 0.35; // rubber-band at the first/last post
      }
      const base = tiktokPager.index * feed.clientHeight;
      track.style.transform = `translateY(${-base + dragDelta}px)`;
    },
    { passive: false }
  );

  feed.addEventListener("touchend", () => {
    if (!dragging) return;
    dragging = false;
    if (axis !== "y") {
      axis = null;
      return;
    }

    const threshold = feed.clientHeight * 0.18;
    if (dragDelta <= -threshold) tiktokGoTo(tiktokPager.index + 1);
    else if (dragDelta >= threshold) tiktokGoTo(tiktokPager.index - 1);
    else tiktokGoTo(tiktokPager.index);
    axis = null;
    dragDelta = 0;
  });

  window.addEventListener("resize", () => tiktokGoTo(tiktokPager.index, false));
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

/* Similarity hashes are already backfilled automatically on server start,
   but this lets images uploaded before the feature existed (or after a
   future hashing tweak) get caught up on demand, without a restart. */
function setupRecomputeSimilarity() {
  const btn = document.getElementById("recomputeBtn");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    if (btn.classList.contains("spinning")) return;
    btn.classList.add("spinning");

    try {
      const res = await fetch("/api/recompute-similarity", { method: "POST" });
      const data = await res.json();
      showSnackbar(`Ähnlichkeit aktualisiert: ${data.updated} von ${data.total} Bildern`);
    } catch (err) {
      showSnackbar("Aktualisieren fehlgeschlagen.");
    } finally {
      btn.classList.remove("spinning");
    }
  });
}

async function initStatsPage() {
  setupPrivacyShield();
  setupThemeToggle();
  setupRecomputeSimilarity();
  const grid = document.getElementById("statsGrid");
  grid.innerHTML = '<div class="spinner"></div>';

  try {
    const res = await fetch("/api/stats");
    if (!res.ok) throw new Error("Stats request failed");
    const items = await res.json();

    if (!items.length) {
      grid.innerHTML = emptyStateHTML("Noch keine Statistik vorhanden.");
      return;
    }

    grid.innerHTML = "";
    items.forEach((item, i) => {
      const tile = document.createElement("div");
      tile.className = "stat-tile";
      tile.innerHTML = `
        <img src="${item.url}" loading="lazy" decoding="async" alt="" draggable="false" />
        <span class="stat-rank">${i + 1}</span>
        <span class="stat-likes">${ICON_HEART}${item.like_count}</span>
      `;
      grid.appendChild(tile);
    });
  } catch (err) {
    grid.innerHTML = emptyStateHTML("Fehler beim Laden der Statistik.");
    showSnackbar("Fehler beim Laden der Statistik.");
  }
}
