// content.js
// -----------------------------------------------------------------------------
// DirectIn / Get Off LinkedIn — Content Script (MV3)
//
// Injects:
// 1) Overlay iframe (overlay.html) in a floating panel.
// 2) A minimized dock on the right side that can be dragged up/down.
//
// Implemented behaviors:
// - Expanded mode = 90% viewport modal w/ rounded corners + backdrop.
// - Clicking overlay "close" behaves like MINIMIZE (prevents lingering blur).
// - Dock is ~75% size (smaller).
// - Dock can be dragged from anywhere.
// - Hover reveals dark-blue handle w/ 3 white dots.
// - Minus button appears ONLY on hover (same time as 3 dots), click => minimize.
// - Red notification badge is pinned to the top-right of the dock.
// -----------------------------------------------------------------------------

// ===============================
// IDs + storage keys
// ===============================
const ROOT_ID = "gol_root_wrap";
const PANEL_ID = "gol_panel_shell";
const IFRAME_ID = "gol_iframe";
const DOCK_ID = "gol_dock";

const STORAGE_MIN_KEY = "gol_ui_minimized";
const STORAGE_TOP_KEY = "gol_dock_top";
const STORAGE_EXPANDED_KEY = "gol_ui_expanded";

// Keys written by overlay (read-only here for badge counting)
const STORAGE_PROFILE_KEY = "userProfile";
const STORAGE_CACHE_KEY = "companyCache";
const STORAGE_BADGE_OVERRIDE_KEY = "gol_badge_count"; // optional future override

// ===============================
// Visual constants
// ===============================
const BRAND_BLUE = "#0A66C2";
const HANDLE_BLUE = "#084C9E";
const DOT_WHITE = "#FFFFFF";

// Dock sizing (~75% of previous)
const TILE = 66;         // collapsed square size (px)
const HANDLE_W = 24;     // ~1/3 of TILE
const DOCK_W_HOVER = TILE + HANDLE_W;

const RADIUS = 16;
const SHADOW = "0 8px 30px rgba(0,0,0,0.12)";
const BORDER = "1px solid #ddd";

// Floating panel sizing (not expanded)
const PANEL_SMALL = { w: 440, h: 520 };

// Expanded modal sizing (still popup)
const MODAL_W = "90vw";
const MODAL_H = "90vh";
const MODAL_RADIUS = 16;

// Badge behavior
const NEW_DAYS = 7;
const BADGE_BG = "#FF3B30";
const BADGE_MAX = 99;

// Asset
const LOGO_URL = chrome.runtime.getURL("directinlogo.png");

// ===============================
// Utilities
// ===============================
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function px(n) {
  return `${n}px`;
}
function daysAgo(iso) {
  if (!iso) return 9999;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 9999;
  return (Date.now() - t) / (1000 * 60 * 60 * 24);
}
function isNew(iso) {
  return daysAgo(iso) <= NEW_DAYS;
}

// Minimal relevance heuristic (only for badge count)
function isRelevantTitle(title, roles) {
  const t = (title || "").toLowerCase();

  // Exclude senior+ and management
  if (t.includes("senior") || t.includes("staff") || t.includes("principal") || t.includes("lead")) return false;
  if (t.includes("manager") || t.includes("head of") || t.includes("director")) return false;

  // If roles empty, allow basic engineer/software
  if (!roles || roles.length === 0) return t.includes("engineer") || t.includes("software");

  const wantsSWE = roles.includes("swe");
  const wantsML = roles.includes("ml");
  const wantsData = roles.includes("data");
  const wantsHW = roles.includes("hardware");
  const wantsIntern = roles.includes("intern");

  const isIntern = t.includes("intern");
  const isML = t.includes("machine learning") || t.includes("ml ") || t.includes("ml/");
  const isData = t.includes("data");
  const isHW = t.includes("hardware") || t.includes("embedded");
  const isEng = t.includes("engineer") || t.includes("software");

  if (wantsIntern && isIntern) return true;
  if (wantsML && (isML || (isEng && t.includes("ai")))) return true;
  if (wantsData && isData) return true;
  if (wantsHW && isHW) return true;
  if (wantsSWE && isEng) return true;

  return false;
}

// ===============================
// Inject once
// ===============================
(function injectOnce() {
  // Remove any previous injected UI (prevents double docks)
  const oldWrap = document.getElementById(ROOT_ID);
  const oldDock = document.getElementById(DOCK_ID);
  if (oldWrap) oldWrap.remove();
  if (oldDock) oldDock.remove();

  // -------------------------------
  // Root wrap + panel shell
  // -------------------------------
  const wrap = document.createElement("div");
  wrap.id = ROOT_ID;
  wrap.style.position = "fixed";
  wrap.style.top = px(20);
  wrap.style.right = px(20);
  wrap.style.zIndex = "999999";
  wrap.style.fontFamily = "system-ui, -apple-system, Segoe UI, sans-serif";

  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.style.position = "relative";
  panel.style.display = "block";

  const iframe = document.createElement("iframe");
  iframe.id = IFRAME_ID;
  iframe.src = chrome.runtime.getURL("overlay.html");
  iframe.style.width = px(PANEL_SMALL.w);
  iframe.style.height = px(PANEL_SMALL.h);
  iframe.style.border = BORDER;
  iframe.style.borderRadius = px(12);
  iframe.style.background = "white";
  iframe.style.boxShadow = SHADOW;
  iframe.style.display = "block";

  panel.appendChild(iframe);
  wrap.appendChild(panel);
  document.body.appendChild(wrap);

  // -------------------------------
  // Dock (minimized UI)
  // -------------------------------
  const dock = document.createElement("div");
  dock.id = DOCK_ID;

  dock.style.position = "fixed";
  dock.style.right = px(12);
  dock.style.top = px(160);
  dock.style.width = px(TILE);
  dock.style.height = px(TILE);
  dock.style.borderRadius = px(RADIUS);
  dock.style.overflow = "hidden";
  dock.style.border = BORDER;
  dock.style.background = "white";
  dock.style.boxShadow = SHADOW;
  dock.style.zIndex = "999999";
  dock.style.display = "none";
  dock.style.userSelect = "none";
  dock.style.transition = "width 160ms ease";

  // Handle (dark blue) + dots (white)
  const handle = document.createElement("div");
  handle.style.position = "absolute";
  handle.style.top = "0";
  handle.style.right = "0";
  handle.style.width = px(HANDLE_W);
  handle.style.height = px(TILE);
  handle.style.display = "flex";
  handle.style.alignItems = "center";
  handle.style.justifyContent = "center";
  handle.style.background = HANDLE_BLUE;
  handle.style.borderLeft = "1px solid rgba(255,255,255,0.14)";
  handle.style.opacity = "0";
  handle.style.transition = "opacity 160ms ease";

  const dots = document.createElement("div");
  dots.style.display = "grid";
  dots.style.gridTemplateRows = "repeat(3, 5px)";
  dots.style.gap = "7px";

  for (let i = 0; i < 3; i++) {
    const dot = document.createElement("div");
    dot.style.width = "5px";
    dot.style.height = "5px";
    dot.style.borderRadius = "50%";
    dot.style.background = DOT_WHITE;
    dots.appendChild(dot);
  }
  handle.appendChild(dots);

  // Logo tile (blue) with full-bleed logo image
  const logoTile = document.createElement("div");
  logoTile.style.position = "absolute";
  logoTile.style.top = "0";
  logoTile.style.right = "0";
  logoTile.style.width = px(TILE);
  logoTile.style.height = px(TILE);
  logoTile.style.background = BRAND_BLUE;
  logoTile.style.transition = "transform 160ms ease";
  logoTile.style.willChange = "transform";

  const logoImg = document.createElement("img");
  logoImg.src = LOGO_URL;
  logoImg.alt = "DirectIn";
  logoImg.draggable = false;
  logoImg.style.width = "100%";
  logoImg.style.height = "100%";
  logoImg.style.objectFit = "cover";
  logoImg.style.display = "block";
  logoImg.style.boxShadow = "none";
  logoImg.style.borderRadius = "0";
  logoTile.appendChild(logoImg);

  // Badge pinned to top-right of the DOCK (not sliding with logo)
  const badge = document.createElement("div");
  badge.style.position = "absolute";
  badge.style.top = px(6);
  badge.style.right = px(6);
  badge.style.zIndex = "3";
  badge.style.minWidth = px(18);
  badge.style.height = px(18);
  badge.style.padding = "0 6px";
  badge.style.borderRadius = "999px";
  badge.style.background = BADGE_BG;
  badge.style.color = "#fff";
  badge.style.fontSize = "12px";
  badge.style.fontWeight = "700";
  badge.style.display = "none";
  badge.style.alignItems = "center";
  badge.style.justifyContent = "center";
  badge.style.lineHeight = "18px";
  badge.style.boxShadow = "0 6px 14px rgba(0,0,0,0.16)";

  // Minus bubble (appears ONLY on dock hover)
  const minusBtn = document.createElement("button");
  minusBtn.type = "button";
  minusBtn.setAttribute("aria-label", "Minimize");
  minusBtn.style.position = "absolute";
  minusBtn.style.top = px(6);
  minusBtn.style.left = px(6);
  minusBtn.style.width = px(30);
  minusBtn.style.height = px(30);
  minusBtn.style.borderRadius = "999px";
  minusBtn.style.border = "none";
  minusBtn.style.background = HANDLE_BLUE;
  minusBtn.style.boxShadow = "0 6px 18px rgba(0,0,0,0.18)";
  minusBtn.style.cursor = "pointer";
  minusBtn.style.display = "none";          // only on hover
  minusBtn.style.opacity = "0";
  minusBtn.style.transition = "opacity 160ms ease";
  minusBtn.style.alignItems = "center";
  minusBtn.style.justifyContent = "center";
  minusBtn.style.padding = "0";
  minusBtn.style.zIndex = "4";

  const minusSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  minusSvg.setAttribute("viewBox", "0 0 24 24");
  minusSvg.style.width = "16px";
  minusSvg.style.height = "16px";

  const minusPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  minusPath.setAttribute("d", "M5 12h14");
  minusPath.setAttribute("stroke", "#FFFFFF");
  minusPath.setAttribute("stroke-width", "2.6");
  minusPath.setAttribute("stroke-linecap", "round");
  minusSvg.appendChild(minusPath);
  minusBtn.appendChild(minusSvg);

  minusBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setMinimized(true);
  });

  dock.appendChild(handle);
  dock.appendChild(logoTile);
  dock.appendChild(badge);
  dock.appendChild(minusBtn);
  document.body.appendChild(dock);

  // ===============================
  // Layout state (floating vs modal)
  // ===============================
  function applyFloatingLayout() {
    // Wrap is top-right floating container
    wrap.style.position = "fixed";
    wrap.style.top = px(20);
    wrap.style.right = px(20);
    wrap.style.left = "auto";
    wrap.style.bottom = "auto";

    // Clear modal backdrop blur (important)
    wrap.style.display = "block";
    wrap.style.background = "transparent";
    wrap.style.backdropFilter = "";
    wrap.style.alignItems = "";
    wrap.style.justifyContent = "";

    iframe.style.width = px(PANEL_SMALL.w);
    iframe.style.height = px(PANEL_SMALL.h);
    iframe.style.borderRadius = px(12);
    iframe.style.border = BORDER;
    iframe.style.boxShadow = SHADOW;
  }

  function applyModalLayout() {
    // Wrap covers viewport and centers the panel
    wrap.style.top = "0";
    wrap.style.right = "0";
    wrap.style.bottom = "0";
    wrap.style.left = "0";

    wrap.style.display = "flex";
    wrap.style.alignItems = "center";
    wrap.style.justifyContent = "center";

    wrap.style.background = "rgba(0,0,0,0.22)";
    wrap.style.backdropFilter = "blur(2px)";

    iframe.style.width = MODAL_W;
    iframe.style.height = MODAL_H;
    iframe.style.borderRadius = px(MODAL_RADIUS);
    iframe.style.border = BORDER;
    iframe.style.boxShadow = SHADOW;
  }

  function setExpanded(expanded) {
    chrome.storage.local.set({ [STORAGE_EXPANDED_KEY]: expanded });
    if (expanded) applyModalLayout();
    else applyFloatingLayout();
  }

  // ===============================
  // Minimized state
  // ===============================
  function setMinimized(min) {
    chrome.storage.local.set({ [STORAGE_MIN_KEY]: min });

    if (min) {
      // Always exit modal when minimizing (prevents blurred LinkedIn)
      chrome.storage.local.set({ [STORAGE_EXPANDED_KEY]: false });
      applyFloatingLayout();

      wrap.style.display = "none";
      dock.style.display = "block";
      setDockHover(false);
    } else {
      wrap.style.display = "block";
      dock.style.display = "none";

      chrome.storage.local.get([STORAGE_EXPANDED_KEY], (data) => {
        setExpanded(Boolean(data[STORAGE_EXPANDED_KEY]));
      });
    }
  }

  // ===============================
  // Dock hover (reveal handle + minus)
  // ===============================
  function setDockHover(on) {
    dock.style.width = on ? px(DOCK_W_HOVER) : px(TILE);
    handle.style.opacity = on ? "1" : "0";
    logoTile.style.transform = on ? `translateX(-${HANDLE_W}px)` : "translateX(0)";

    // Minus appears ONLY on hover (same time as dots)
    minusBtn.style.display = on ? "flex" : "none";
    minusBtn.style.opacity = on ? "1" : "0";
  }

  dock.addEventListener("mouseenter", () => setDockHover(true));
  dock.addEventListener("mouseleave", () => {
    if (dockIsDragging) return;
    setDockHover(false);
  });

  // ===============================
  // Dock drag from anywhere
  // ===============================
  let dockIsDragging = false;
  let dragOffsetY = 0;
  let dragMoved = 0;

  dock.addEventListener("pointerdown", (e) => {
    dockIsDragging = true;
    dragMoved = 0;

    const rect = dock.getBoundingClientRect();
    dragOffsetY = e.clientY - rect.top;

    dock.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  dock.addEventListener("pointermove", (e) => {
    if (!dockIsDragging) return;

    const nextTop = e.clientY - dragOffsetY;
    const minTop = 8;
    const maxTop = window.innerHeight - TILE - 8;
    const clamped = clamp(nextTop, minTop, maxTop);
    dock.style.top = px(clamped);

    dragMoved += Math.abs(e.movementY || 0);
  });

  function endDockDrag(e) {
    if (!dockIsDragging) return;
    dockIsDragging = false;

    const topPx = parseFloat(dock.style.top) || 160;
    chrome.storage.local.set({ [STORAGE_TOP_KEY]: topPx });

    // If it was essentially a click, restore the panel
    if (dragMoved < 6) setMinimized(false);

    setDockHover(dock.matches(":hover"));

    if (e?.pointerId != null) {
      try { dock.releasePointerCapture(e.pointerId); } catch {}
    }
  }

  dock.addEventListener("pointerup", endDockDrag);
  dock.addEventListener("pointercancel", endDockDrag);

  window.addEventListener("resize", () => {
    const topPx = parseFloat(dock.style.top) || 160;
    const minTop = 8;
    const maxTop = window.innerHeight - TILE - 8;
    dock.style.top = px(clamp(topPx, minTop, maxTop));
  });

  // ===============================
  // Badge helpers
  // ===============================
  function setBadgeCount(n) {
    const count = Math.max(0, Math.min(BADGE_MAX, Number(n) || 0));
    if (count <= 0) {
      badge.style.display = "none";
      badge.textContent = "";
      return;
    }
    badge.style.display = "flex";
    badge.textContent = count >= BADGE_MAX ? `${BADGE_MAX}+` : String(count);
  }

  function refreshBadgeFromStorage() {
    chrome.storage.local.get(
      [STORAGE_BADGE_OVERRIDE_KEY, STORAGE_PROFILE_KEY, STORAGE_CACHE_KEY],
      (data) => {
        const override = data[STORAGE_BADGE_OVERRIDE_KEY];
        if (typeof override === "number") {
          setBadgeCount(override);
          return;
        }

        const profile = data[STORAGE_PROFILE_KEY] || {};
        const roles = profile.roles || [];
        const cache = data[STORAGE_CACHE_KEY] || {};

        const seen = new Set();
        let total = 0;

        for (const companyId of Object.keys(cache)) {
          const jobs = cache[companyId]?.jobs || [];
          for (const job of jobs) {
            const id = job?.id != null ? String(job.id) : null;
            if (!id || seen.has(id)) continue;

            if (isNew(job.createdAt) && isRelevantTitle(job.title, roles)) {
              seen.add(id);
              total += 1;
              if (total >= BADGE_MAX) break;
            }
          }
          if (total >= BADGE_MAX) break;
        }

        setBadgeCount(total);
      }
    );
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[STORAGE_BADGE_OVERRIDE_KEY] || changes[STORAGE_CACHE_KEY] || changes[STORAGE_PROFILE_KEY]) {
      refreshBadgeFromStorage();
    }
  });

  // ===============================
  // Overlay -> content messages
  // ===============================
  window.addEventListener("message", (event) => {
    if (event.source !== iframe.contentWindow) return;
    const msg = event.data;
    if (!msg || !msg.type) return;

    // Treat close-ish events as minimize to avoid lingering blur
    if (msg.type === "GOL_MINIMIZE" || msg.type === "GOL_CLOSE" || msg.type === "GOL_EXIT" || msg.type === "GOL_HIDE") {
      setMinimized(true);
      return;
    }

    if (msg.type === "GOL_RESTORE") {
      setMinimized(false);
      return;
    }

    if (msg.type === "GOL_TOGGLE_EXPAND") {
      chrome.storage.local.get([STORAGE_EXPANDED_KEY], (data) => {
        setExpanded(!Boolean(data[STORAGE_EXPANDED_KEY]));
      });
      return;
    }
  });

  // Safety net: if iframe becomes hidden, minimize + clear blur
  const iframeObserver = new MutationObserver(() => {
    const cs = window.getComputedStyle(iframe);
    const hidden = cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0";
    if (hidden) setMinimized(true);
  });
  iframeObserver.observe(iframe, { attributes: true, attributeFilter: ["style", "class"] });

  // ===============================
  // Initial restore from storage
  // ===============================
  chrome.storage.local.get([STORAGE_MIN_KEY, STORAGE_TOP_KEY, STORAGE_EXPANDED_KEY], (data) => {
    // Dock top restore
    const savedTop = typeof data[STORAGE_TOP_KEY] === "number" ? data[STORAGE_TOP_KEY] : 160;
    const minTop = 8;
    const maxTop = window.innerHeight - TILE - 8;
    dock.style.top = px(clamp(savedTop, minTop, maxTop));

    // Expanded restore (only matters when not minimized)
    setExpanded(Boolean(data[STORAGE_EXPANDED_KEY]));

    // Minimized restore
    setMinimized(Boolean(data[STORAGE_MIN_KEY]));

    // Start collapsed
    setDockHover(false);

    // Badge init
    refreshBadgeFromStorage();
  });
})();
