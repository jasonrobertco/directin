// content.js
// -----------------------------------------------------------------------------
// DirectIn — Content Script (MV3)
//
// Injects:
// - Overlay iframe (overlay.html)
// - Minimized draggable dock on the right
//
// Dock behavior:
// - Idle: SQUARE (TILE x TILE)
// - Hover: expands to pill (TILE+HANDLE_W x TILE) AND blue tile slides left
//          revealing the dark-blue handle + 3 dots underneath
// - Minus bubble appears ONLY on hover, slightly outside top-left
// - Badge pinned top-right of dock (does not slide)
//
// State behavior:
// - On EVERY page load: start minimized (dock visible, overlay hidden)
// - Minus: closes UI completely (removes from DOM) until user clicks extension icon
// - Extension icon click: re-opens to minimized dock
//
// Overlay messaging:
// - Accepts postMessage from iframe:
//   - GOL_MINIMIZE / GOL_CLOSE => minimize (dock)
//   - GOL_TOGGLE_EXPAND        => 90% modal
//   - GOL_RESTORE              => show overlay
// -----------------------------------------------------------------------------

// ===============================
// IDs (for singleton cleanup)
// ===============================
const ROOT_ID = "directin_root_wrap";
const PANEL_ID = "directin_panel_shell";
const IFRAME_ID = "directin_iframe";

const DOCK_ID = "directin_dock_outer";
const DOCK_CLIP_ID = "directin_dock_clip";

// ===============================
// Storage keys
// ===============================
const STORAGE_TOP_KEY = "directin_dock_top";
const STORAGE_EXPANDED_KEY = "directin_ui_expanded"; // only meaningful while overlay open

// Data keys written by overlay.js (badge source)
const STORAGE_PROFILE_KEY = "userProfile";
const STORAGE_CACHE_KEY = "companyCache";

// Optional override for badge (future)
const STORAGE_BADGE_OVERRIDE_KEY = "directin_badge_count";

// ===============================
// Brand + sizing (tweak here)
// ===============================
const BRAND_BLUE = "#0A66C2";
const HANDLE_BLUE = "#084C9E";
const DOT_WHITE = "#FFFFFF";
const BADGE_RED = "#FF3B30";

const TILE = 52;        // idle dock is a square TILE x TILE
const HANDLE_W = 26;    // width of dots handle revealed on hover
const DOCK_W = TILE + HANDLE_W;

const RADIUS = 16;
const SHADOW = "0 10px 26px rgba(0,0,0,0.14)";

// Overlay sizing
const PANEL_FLOAT_W = 440;
const PANEL_FLOAT_H = 520;

const MODAL_W = "90vw";
const MODAL_H = "90vh";
const MODAL_RADIUS = 16;

// Badge logic
const NEW_DAYS = 7;
const BADGE_MAX = 99;

// Assets
const LOGO_SVG_URL = chrome.runtime.getURL("directinlogo.svg");
const LOGO_PNG_URL = chrome.runtime.getURL("directinlogo.png");

// ===============================
// Utilities
// ===============================
function px(n) { return `${n}px`; }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function daysAgo(iso) {
  if (!iso) return 9999;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 9999;
  return (Date.now() - t) / (1000 * 60 * 60 * 24);
}
function isNew(iso) { return daysAgo(iso) <= NEW_DAYS; }

// Minimal relevance heuristic for badge counting
function isRelevantTitle(title, roles) {
  const t = String(title || "").toLowerCase();

  // Filter out senior+ and management
  if (t.includes("senior") || t.includes("staff") || t.includes("principal") || t.includes("lead")) return false;
  if (t.includes("manager") || t.includes("head of") || t.includes("director")) return false;

  // If no roles provided, accept general eng/software
  if (!roles || roles.length === 0) return (t.includes("engineer") || t.includes("software"));

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

// Replace your existing isRelevantTitle() in content.js with this version,
// and update refreshBadgeFromStorage() to read profile.roleQueries.

// --- Matching helpers (lightweight copy) ---
const SENIORITY_BLOCKLIST = ["senior", "staff", "principal", "lead", "manager", "director", "head"];

const TOKEN_ALIASES = {
  engineer: ["engineer", "engineering"],
  engineering: ["engineering", "engineer"],
  intern: ["intern", "internship"],
  internship: ["internship", "intern"],
  grad: ["grad", "graduate"],
  graduate: ["graduate", "grad"],
};

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function expandQuery(q) {
  let s = normalize(q);
  s = s.replace(/\bswe\b/g, "software engineer");
  s = s.replace(/\bsde\b/g, "software engineer");
  s = s.replace(/\bml\b/g, "machine learning");
  return s;
}

function tokenize(s) {
  const n = normalize(s);
  return n ? n.split(" ").filter(Boolean) : [];
}

function hasSeniority(titleNorm) {
  return SENIORITY_BLOCKLIST.some((w) => titleNorm.includes(w));
}

function titleTokenSet(title) {
  const t = normalize(title);
  return new Set(t ? t.split(" ") : []);
}

function tokenMatchesTitle(token, tset) {
  const aliases = TOKEN_ALIASES[token] || [token];
  return aliases.some((a) => {
    const an = normalize(a);
    if (!an) return false;
    const parts = an.split(" ").filter(Boolean);
    return parts.every((p) => tset.has(p));
  });
}

function scoreTitleAgainstQuery(title, query) {
  const titleNorm = normalize(title);
  if (hasSeniority(titleNorm)) return 0;

  const tset = titleTokenSet(title);
  const qTokens = tokenize(expandQuery(query)).filter(
    (w) => !["and", "of", "the", "a", "an", "to", "for"].includes(w)
  );

  if (qTokens.length === 0) return 0;

  let matched = 0;
  for (const tok of qTokens) {
    if (tokenMatchesTitle(tok, tset)) matched += 1;
  }

  return matched / qTokens.length;
}

function isRelevantTitle(title, roleQueries) {
  const queries = Array.isArray(roleQueries) ? roleQueries : [];
  if (queries.length === 0) {
    // fallback: keep old behavior if nothing configured
    const t = normalize(title);
    return t.includes("engineer") || t.includes("software");
  }

  let best = 0;
  for (const q of queries) best = Math.max(best, scoreTitleAgainstQuery(title, q));
  return best >= 0.75; // same threshold as overlay
}


// ===============================
// Global (content-script) state
// ===============================
let ui = null;                 // holds DOM refs once built
let isMinimized = true;        // ALWAYS start minimized on load
let isClosed = false;          // "minus" sets this true until toolbar click reopens
let dockIsDragging = false;

// ===============================
// Build / destroy UI
// ===============================
function destroyUI() {
  if (!ui) return;
  ui.wrap?.remove();
  ui.dockOuter?.remove();
  ui = null;
}

function buildUI() {
  // Ensure singleton (remove previous)
  destroyUI();

  // -------------------------------
  // Overlay wrap + iframe
  // -------------------------------
  const wrap = document.createElement("div");
  wrap.id = ROOT_ID;
  wrap.style.position = "fixed";
  wrap.style.top = px(20);
  wrap.style.right = px(20);
  wrap.style.zIndex = "999999";
  wrap.style.fontFamily = "system-ui, -apple-system, Segoe UI, sans-serif";
  wrap.style.display = "none"; // starts minimized => hidden

  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.style.position = "relative";
  panel.style.display = "block";

  const iframe = document.createElement("iframe");
  iframe.id = IFRAME_ID;
  iframe.src = chrome.runtime.getURL("overlay.html");
  iframe.style.display = "block";
  iframe.style.width = px(PANEL_FLOAT_W);
  iframe.style.height = px(PANEL_FLOAT_H);
  iframe.style.border = "1px solid rgba(0,0,0,0.12)";
  iframe.style.borderRadius = px(12);
  iframe.style.background = "white";
  iframe.style.boxShadow = SHADOW;

  panel.appendChild(iframe);
  wrap.appendChild(panel);
  document.body.appendChild(wrap);

  // -------------------------------
  // Dock outer (overflow visible so minus can protrude)
  // Idle: square (width = TILE)
  // Hover: pill (width = DOCK_W)
  // -------------------------------
  const dockOuter = document.createElement("div");
  dockOuter.id = DOCK_ID;
  dockOuter.style.position = "fixed";
  dockOuter.style.right = px(12);
  dockOuter.style.top = px(160);
  dockOuter.style.width = px(TILE);    // IMPORTANT: square idle
  dockOuter.style.height = px(TILE);
  dockOuter.style.zIndex = "999999";
  dockOuter.style.userSelect = "none";
  dockOuter.style.cursor = "pointer";
  dockOuter.style.display = "block";  // starts minimized => visible
  dockOuter.style.overflow = "visible";
  dockOuter.style.transition = "width 170ms ease";

  // Clip container (rounded + sliding clipping)
  const dockClip = document.createElement("div");
  dockClip.id = DOCK_CLIP_ID;
  dockClip.style.position = "absolute";
  dockClip.style.top = "0";
  dockClip.style.left = "0";
  dockClip.style.width = "100%";       // matches dockOuter width
  dockClip.style.height = "100%";
  dockClip.style.borderRadius = px(RADIUS);
  dockClip.style.overflow = "hidden";
  dockClip.style.boxShadow = SHADOW;
  dockClip.style.background = "transparent";

  // Handle (always exists underneath, only becomes visible once dock expands)
  const handle = document.createElement("div");
  handle.style.position = "absolute";
  handle.style.top = "0";
  handle.style.right = "0";
  handle.style.width = px(HANDLE_W);
  handle.style.height = px(TILE);
  handle.style.background = HANDLE_BLUE;
  handle.style.display = "flex";
  handle.style.alignItems = "center";
  handle.style.justifyContent = "center";

  // 3 vertical dots (white)
  const dots = document.createElement("div");
  dots.style.display = "flex";
  dots.style.flexDirection = "column";
  dots.style.gap = "8px";
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement("div");
    dot.style.width = "5px";
    dot.style.height = "5px";
    dot.style.borderRadius = "50%";
    dot.style.background = DOT_WHITE;
    dots.appendChild(dot);
  }
  handle.appendChild(dots);

  // Blue cover (slider): covers handle when idle; slides left on hover
  const slider = document.createElement("div");
  slider.style.position = "absolute";
  slider.style.top = "0";
  slider.style.left = "0";
  slider.style.width = px(DOCK_W);
  slider.style.height = px(TILE);
  slider.style.background = BRAND_BLUE;
  slider.style.transition = "transform 170ms ease";
  slider.style.willChange = "transform";
  slider.style.transform = "translateX(0)"; // idle: covers handle

  // Logo area: fixed in the left square (DOES NOT MOVE)
const logoWrap = document.createElement("div");
logoWrap.style.position = "absolute";
logoWrap.style.left = "0";
logoWrap.style.top = "0";
logoWrap.style.width = px(TILE);
logoWrap.style.height = px(TILE);
logoWrap.style.display = "flex";
logoWrap.style.alignItems = "center";
logoWrap.style.justifyContent = "center";
logoWrap.style.zIndex = "2"; // above the cover

const logoImg = document.createElement("img");
logoImg.src = LOGO_SVG_URL;
logoImg.alt = "DirectIn";
logoImg.draggable = false;
logoImg.style.width = "100%";
logoImg.style.height = "100%";
logoImg.style.objectFit = "cover";
logoImg.style.display = "block";
logoImg.style.boxShadow = "none";
logoImg.style.filter = "none";
logoImg.onerror = () => {
  logoImg.onerror = null;
  logoImg.src = LOGO_PNG_URL;
};

logoWrap.appendChild(logoImg);

  // Assemble layers (order matters)
  dockClip.appendChild(handle);     // bottom
  dockClip.appendChild(slider);     // middle (slides)
  dockClip.appendChild(logoWrap);   // top (fixed)
  dockOuter.appendChild(dockClip);



  // Minus bubble (outside top-left) — shown only on hover
  const minusBtn = document.createElement("button");
  minusBtn.type = "button";
  minusBtn.setAttribute("aria-label", "Close DirectIn");
  minusBtn.style.position = "absolute";
  minusBtn.style.top = px(-10);
  minusBtn.style.left = px(-10);
  minusBtn.style.width = px(30);
  minusBtn.style.height = px(30);
  minusBtn.style.borderRadius = "999px";
  minusBtn.style.border = "none";
  minusBtn.style.background = HANDLE_BLUE;
  minusBtn.style.boxShadow = "0 10px 22px rgba(0,0,0,0.18)";
  minusBtn.style.cursor = "pointer";
  minusBtn.style.display = "none"; // only on hover
  minusBtn.style.opacity = "0";
  minusBtn.style.transition = "opacity 170ms ease";
  minusBtn.style.zIndex = "5";
  minusBtn.style.padding = "0";

  // Stop drags from starting on minus
  minusBtn.addEventListener("pointerdown", (e) => e.stopPropagation());

  // Minus icon
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

  // MINUS = CLOSE COMPLETELY
  minusBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeCompletely();
  });

  dockOuter.appendChild(minusBtn);

  // Badge pinned top-right of dock (outside corner for "notification")
  const badge = document.createElement("div");
  badge.style.position = "absolute";
  badge.style.top = px(-8);
  badge.style.right = px(-8);
  badge.style.zIndex = "6";
  badge.style.minWidth = px(18);
  badge.style.height = px(18);
  badge.style.padding = "0 6px";
  badge.style.borderRadius = "999px";
  badge.style.background = BADGE_RED;
  badge.style.color = "#fff";
  badge.style.fontSize = "12px";
  badge.style.fontWeight = "800";
  badge.style.display = "none";
  badge.style.alignItems = "center";
  badge.style.justifyContent = "center";
  badge.style.lineHeight = "18px";
  badge.style.boxShadow = "0 10px 22px rgba(0,0,0,0.18)";
  dockOuter.appendChild(badge);

  document.body.appendChild(dockOuter);

  // Store refs
  ui = {
    wrap,
    iframe,
    dockOuter,
    dockClip,
    slider,
    minusBtn,
    badge
  };

  // Attach behaviors
  attachOverlayMessaging();
  attachDockInteractions();
  refreshBadgeFromStorage(); // initial badge
}

// ===============================
// Overlay layout (floating vs modal)
// ===============================
function applyFloatingLayout() {
  if (!ui) return;

  ui.wrap.style.position = "fixed";
  ui.wrap.style.top = px(20);
  ui.wrap.style.right = px(20);
  ui.wrap.style.left = "auto";
  ui.wrap.style.bottom = "auto";

  ui.wrap.style.display = "block";
  ui.wrap.style.background = "transparent";
  ui.wrap.style.backdropFilter = "";

  // Clear modal flex positioning
  ui.wrap.style.alignItems = "";
  ui.wrap.style.justifyContent = "";

  ui.iframe.style.width = px(PANEL_FLOAT_W);
  ui.iframe.style.height = px(PANEL_FLOAT_H);
  ui.iframe.style.borderRadius = px(12);
  ui.iframe.style.boxShadow = SHADOW;
}

function applyModalLayout() {
  if (!ui) return;

  ui.wrap.style.top = "0";
  ui.wrap.style.right = "0";
  ui.wrap.style.bottom = "0";
  ui.wrap.style.left = "0";

  ui.wrap.style.display = "flex";
  ui.wrap.style.alignItems = "center";
  ui.wrap.style.justifyContent = "center";

  ui.wrap.style.background = "rgba(0,0,0,0.22)";
  ui.wrap.style.backdropFilter = "blur(2px)";

  ui.iframe.style.width = MODAL_W;
  ui.iframe.style.height = MODAL_H;
  ui.iframe.style.borderRadius = px(MODAL_RADIUS);
  ui.iframe.style.boxShadow = SHADOW;
}

function setExpanded(expanded) {
  chrome.storage.local.set({ [STORAGE_EXPANDED_KEY]: expanded });
  if (expanded) applyModalLayout();
  else applyFloatingLayout();
}

// ===============================
// Minimize / restore / close
// ===============================
function setMinimized(min) {
  if (!ui) return;

  isMinimized = min;

  if (min) {
    // Ensure blur is removed (exit modal)
    chrome.storage.local.set({ [STORAGE_EXPANDED_KEY]: false });
    applyFloatingLayout();

    ui.wrap.style.display = "none";
    ui.dockOuter.style.display = "block";
    setDockHover(false);
  } else {
    ui.dockOuter.style.display = "none";
    ui.wrap.style.display = "block";

    chrome.storage.local.get([STORAGE_EXPANDED_KEY], (data) => {
      setExpanded(Boolean(data[STORAGE_EXPANDED_KEY]));
    });
  }
}

function closeCompletely() {
  // "Minus" means: remove all UI and do nothing until user clicks extension icon
  isClosed = true;
  destroyUI();
}

// ===============================
// Dock hover: square -> pill + slide
// ===============================
function setDockHover(on) {
  if (!ui) return;

  // Expand the dock width so the handle can exist
  ui.dockOuter.style.width = on ? px(DOCK_W) : px(TILE);

  // Slide blue tile left to reveal handle (underneath)
  ui.slider.style.transform = on ? `translateX(-${HANDLE_W}px)` : "translateX(0)";

  // Minus bubble only on hover
  ui.minusBtn.style.display = on ? "block" : "none";
  ui.minusBtn.style.opacity = on ? "1" : "0";
}

// ===============================
// Dock interactions: hover, drag, click-to-open
// ===============================
function attachDockInteractions() {
  if (!ui) return;

  // Hover behavior
  ui.dockOuter.addEventListener("mouseenter", () => {
    if (dockIsDragging) return;
    setDockHover(true);
  });

  ui.dockOuter.addEventListener("mouseleave", () => {
    if (dockIsDragging) return;
    setDockHover(false);
  });

  // Drag from anywhere
  let dragOffsetY = 0;
  let dragMoved = 0;

  ui.dockOuter.addEventListener("pointerdown", (e) => {
    dockIsDragging = true;
    dragMoved = 0;

    const rect = ui.dockOuter.getBoundingClientRect();
    dragOffsetY = e.clientY - rect.top;

    ui.dockOuter.setPointerCapture(e.pointerId);
    e.preventDefault();

    // While dragging, keep expanded visuals
    setDockHover(true);
  });

  ui.dockOuter.addEventListener("pointermove", (e) => {
    if (!dockIsDragging || !ui) return;

    const nextTop = e.clientY - dragOffsetY;
    const minTop = 8;
    const maxTop = window.innerHeight - TILE - 8;
    const clampedTop = clamp(nextTop, minTop, maxTop);

    ui.dockOuter.style.top = px(clampedTop);
    dragMoved += Math.abs(e.movementY || 0);
  });

  function endDrag(e) {
    if (!dockIsDragging || !ui) return;
    dockIsDragging = false;

    const topPx = parseFloat(ui.dockOuter.style.top) || 160;
    chrome.storage.local.set({ [STORAGE_TOP_KEY]: topPx });

    // If drag was tiny, treat as click => open overlay
    if (dragMoved < 6) setMinimized(false);
    else setDockHover(ui.dockOuter.matches(":hover"));

    if (e?.pointerId != null) {
      try { ui.dockOuter.releasePointerCapture(e.pointerId); } catch {}
    }
  }

  ui.dockOuter.addEventListener("pointerup", endDrag);
  ui.dockOuter.addEventListener("pointercancel", endDrag);

  window.addEventListener("resize", () => {
    if (!ui) return;
    const topPx = parseFloat(ui.dockOuter.style.top) || 160;
    const minTop = 8;
    const maxTop = window.innerHeight - TILE - 8;
    ui.dockOuter.style.top = px(clamp(topPx, minTop, maxTop));
  });
}

// ===============================
// Badge logic
// ===============================
function setBadgeCount(n) {
  if (!ui) return;
  const count = Math.max(0, Math.min(BADGE_MAX, Number(n) || 0));

  if (count <= 0) {
    ui.badge.style.display = "none";
    ui.badge.textContent = "";
    return;
  }

  ui.badge.style.display = "flex";
  ui.badge.textContent = count >= BADGE_MAX ? `${BADGE_MAX}+` : String(count);
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

          if (isNew(job.createdAt) && isRelevantTitle(job.title, roleQueries)) {
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

  if (
    changes[STORAGE_BADGE_OVERRIDE_KEY] ||
    changes[STORAGE_PROFILE_KEY] ||
    changes[STORAGE_CACHE_KEY]
  ) {
    refreshBadgeFromStorage();
  }
});

// ===============================
// Overlay iframe messaging (postMessage)
// ===============================
function attachOverlayMessaging() {
  if (!ui) return;

  window.addEventListener("message", (event) => {
    if (!ui) return;
    if (event.source !== ui.iframe.contentWindow) return;

    const msg = event.data;
    if (!msg || !msg.type) return;

    // Treat any "close" intent as minimize (prevents blur bug)
    if (
      msg.type === "GOL_MINIMIZE" ||
      msg.type === "GOL_CLOSE" ||
      msg.type === "GOL_HIDE" ||
      msg.type === "GOL_EXIT"
    ) {
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
}

// ===============================
// Toolbar icon reopen support
// (background.js sends DIRECTIN_OPEN on chrome.action click)
// ===============================
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (!req || !req.type) return;

  if (req.type === "DIRECTIN_OPEN") {
    // If closed, rebuild; always reopen to minimized dock
    if (isClosed || !ui) {
      isClosed = false;
      buildUI();
      restoreDockTop();
    }
    setMinimized(true);
    sendResponse?.({ ok: true });
    return true;
  }

  return false;
});

// ===============================
// Restore dock top position from storage
// ===============================
function restoreDockTop() {
  if (!ui) return;

  chrome.storage.local.get([STORAGE_TOP_KEY], (data) => {
    const savedTop = typeof data[STORAGE_TOP_KEY] === "number" ? data[STORAGE_TOP_KEY] : 160;
    const minTop = 8;
    const maxTop = window.innerHeight - TILE - 8;
    ui.dockOuter.style.top = px(clamp(savedTop, minTop, maxTop));
  });
}

// ===============================
// Boot
// - Always start minimized on LinkedIn page load
// ===============================
(function boot() {
  // Hard cleanup old remnants
  document.getElementById(ROOT_ID)?.remove();
  document.getElementById(DOCK_ID)?.remove();

  // Build UI and start minimized by default
  buildUI();
  restoreDockTop();
  setMinimized(true);
  setDockHover(false);
})();