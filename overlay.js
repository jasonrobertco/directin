// overlay.js
// -----------------------------------------------------------------------------
// Get Off LinkedIn — Overlay UI Controller (runs inside overlay.html iframe)
//
// Goals of this file (MVP):
// 1) Setup screen
//    - Role SEARCH bar (pick up to 3 roles)
//    - Company SEARCH bar (pick up to 3 companies)
//      - Uses a small local directory for suggestions
//      - Also supports pasting a Greenhouse board URL or slug
//      - Unknown slugs are validated by calling the background worker once
//    - No location (removed for now)
//
// 2) App screens
//    - Companies tab: company cards + most recent relevant job
//    - Company detail: list relevant jobs; user can “Track” up to 5 jobs
//    - Tracked tab: shows tracked jobs and their status (open/changed/closed)
//
// Storage (chrome.storage.local):
// - userProfile: { roles: ["swe","ml"], createdAt }
// - trackedCompanies: [{id,name,boardSlug,domain}]
// - trackedJobs: [{jobId, companyId, ... status ... }]
// - companyCache: { [companyId]: { fetchedAt, error, jobs, companyName } }
//
// Background messaging:
// - sendMessage({ type:"FETCH_COMPANY_JOBS", boardSlug, companyName })
//
// -----------------------------------------------------------------------------

// ===============================
// Storage + messaging helpers
// ===============================
function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

function sendMessage(msg) {
  // Best practice: handle runtime.lastError gracefully.
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      const err = chrome.runtime.lastError;
      if (err) return resolve({ error: err.message });
      resolve(res);
    });
  });
}

// ===============================
// DOM refs (setup)
// ===============================
const setupView = document.getElementById("setupView");
const appView = document.getElementById("appView");

// Roles (setup)
const roleSearch = document.getElementById("roleSearch");
const roleSuggestions = document.getElementById("roleSuggestions");
const selectedRolesDiv = document.getElementById("selectedRoles");

// Companies (setup)
const companySearch = document.getElementById("companySearch");
const addCompanyBtn = document.getElementById("addCompanyBtn");
const companySuggestions = document.getElementById("companySuggestions");
const selectedCompanies = document.getElementById("selectedCompanies");
const finishSetupBtn = document.getElementById("finishSetupBtn");

// ===============================
// DOM refs (app)
// ===============================
const profileStatus = document.getElementById("profileStatus");

const tabCompanies = document.getElementById("tabCompanies");
const tabTracked = document.getElementById("tabTracked");

const companiesScreen = document.getElementById("companiesScreen");
const companiesList = document.getElementById("companiesList");
const refreshBtn = document.getElementById("refreshBtn");

const companyJobsScreen = document.getElementById("companyJobsScreen");
const companyJobsTitle = document.getElementById("companyJobsTitle");
const companyJobsList = document.getElementById("companyJobsList");
const backBtn = document.getElementById("backBtn");

const trackedScreen = document.getElementById("trackedScreen");
const trackedList = document.getElementById("trackedList");
const refreshTrackedBtn = document.getElementById("refreshTrackedBtn");

const minimizeBtn = document.getElementById("minimizeBtn");
const expandBtn = document.getElementById("expandBtn");
const settingsBtn = document.getElementById("settingsBtn");

const toast = document.getElementById("toast");

// ===============================
// Constants
// ===============================
const MAX_ROLES = 3;
const MAX_COMPANIES = 3;
const MAX_TRACKED = 5;
const NEW_DAYS = 7;

// These must match your product language, not internal keys.
const ROLE_OPTIONS = [
  { key: "swe", label: "Software Engineer" },
  { key: "ml", label: "ML Engineer" },
  { key: "data", label: "Data Engineer" },
  { key: "hardware", label: "Hardware" },
  { key: "intern", label: "Intern" },
];

// Small built-in directory (extend anytime).
// Note: this is NOT a “Greenhouse database” — it’s your local suggestion list.
const COMPANY_DIRECTORY = [
  { id: "stripe", name: "Stripe", boardSlug: "stripe", domain: "stripe.com" },
  { id: "airbnb", name: "Airbnb", boardSlug: "airbnb", domain: "airbnb.com" },
  { id: "doordash", name: "DoorDash", boardSlug: "doordash", domain: "doordash.com" },
  { id: "figma", name: "Figma", boardSlug: "figma", domain: "figma.com" },
  { id: "coinbase", name: "Coinbase", boardSlug: "coinbase", domain: "coinbase.com" },
];

// ===============================
// App state (single source of truth)
// ===============================
let userProfile = null;              // { roles: [], createdAt }
let companies = [];                  // [{ id, name, boardSlug, domain }]
let trackedJobs = [];                // [{ jobId, companyId, status, ... }]
let companyCache = {};               // companyId -> { fetchedAt, error, jobs, companyName }

// Setup-only state
let setupSelectedRoleKeys = [];      // ["swe","ml",...], up to MAX_ROLES

// ===============================
// UI utilities
// ===============================
function showToast(msg) {
  if (!toast) return; // safe if element missing
  toast.textContent = msg;
  toast.style.display = "block";
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => (toast.style.display = "none"), 1800);
}

function daysAgo(iso) {
  if (!iso) return 9999;
  const dt = new Date(iso);
  const diff = Date.now() - dt.getTime();
  return diff / (1000 * 60 * 60 * 24);
}

function isNewJob(iso) {
  return daysAgo(iso) <= NEW_DAYS;
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString();
}

// Parse either a slug (“stripe”) OR a Greenhouse URL.
// Examples supported:
// - stripe
// - https://boards.greenhouse.io/stripe
// - https://boards.greenhouse.io/v1/boards/stripe/jobs
function slugFromGreenhouseInput(text) {
  const t = String(text || "").trim();
  if (!t) return null;

  // Plain slug (no http)
  if (/^[a-z0-9-]+$/i.test(t) && !t.includes("http")) return t.toLowerCase();

  // URL
  try {
    const u = new URL(t);
    if (!u.hostname.includes("greenhouse.io")) return null;

    const parts = u.pathname.split("/").filter(Boolean);

    // /v1/boards/<slug>/jobs
    if (parts[0] === "v1" && parts[1] === "boards" && parts[2]) return parts[2].toLowerCase();

    // /<slug>
    if (parts[0]) return parts[0].toLowerCase();
  } catch {
    return null;
  }

  return null;
}

function titleizeSlug(slug) {
  return String(slug || "")
    .split("-")
    .map((s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : ""))
    .join(" ");
}

function getLogoUrl(domain) {
  if (!domain) return null;
  return `https://logo.clearbit.com/${domain}`;
}

// ===============================
// Relevance filtering (MVP heuristic)
// ===============================
function isRelevantJob(job) {
  const title = (job.title || "").toLowerCase();

  // Example exclusions for your MVP (tune later)
  if (title.includes("manager") || title.includes("head")) return false;
  if (title.includes("senior") || title.includes("staff") || title.includes("principal") || title.includes("lead")) return false;

  const roles = userProfile?.roles || [];
  if (roles.length === 0) {
    // fallback: SWE-ish only
    return title.includes("engineer") || title.includes("software");
  }

  const wants = new Set(roles);

  const isIntern = title.includes("intern");
  const isML = title.includes("machine learning") || title.includes("ml") || title.includes("ai");
  const isData = title.includes("data");
  const isHW = title.includes("hardware") || title.includes("embedded") || title.includes("firmware");

  const isEng = title.includes("engineer") || title.includes("software");

  if (wants.has("intern") && isIntern) return true;
  if (wants.has("ml") && isML) return true;
  if (wants.has("data") && isData) return true;
  if (wants.has("hardware") && isHW) return true;

  // SWE is the broadest
  if (wants.has("swe") && isEng) return true;

  return false;
}

function getMostRecentRelevant(jobs) {
  const relevant = (jobs || []).filter(isRelevantJob);
  if (relevant.length === 0) return null;
  relevant.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return relevant[0];
}

// ===============================
// One-time event wiring (best practice)
// ===============================
let _eventsWired = false;

function wireEventsOnce() {
  if (_eventsWired) return;
  _eventsWired = true;

  // Topbar actions
  if (minimizeBtn) minimizeBtn.onclick = () => window.parent.postMessage({ type: "GOL_MINIMIZE" }, "*");
  if (expandBtn) expandBtn.onclick = () => window.parent.postMessage({ type: "GOL_TOGGLE_EXPAND" }, "*");
  if (settingsBtn) settingsBtn.onclick = () => enterSetup(true);

  // Setup: company search behaviors
  if (companySearch) {
    companySearch.oninput = () => renderCompanySuggestions(companySearch.value);
    companySearch.onfocus = () => renderCompanySuggestions(companySearch.value);
    companySearch.onkeydown = (e) => {
      if (e.key === "Enter") addCompanyFromInput(companySearch.value);
    };
  }

  if (addCompanyBtn) addCompanyBtn.onclick = () => addCompanyFromInput(companySearch.value);

  // Setup: role search behaviors
  if (roleSearch) {
    roleSearch.oninput = () => renderRoleSuggestions(roleSearch.value);
    roleSearch.onfocus = () => renderRoleSuggestions(roleSearch.value);
    roleSearch.onkeydown = (e) => {
      if (e.key === "Enter") {
        // If user typed an exact label, select it.
        const q = roleSearch.value.trim().toLowerCase();
        const exact = ROLE_OPTIONS.find((r) => r.label.toLowerCase() === q || r.key === q);
        if (exact) addRoleKey(exact.key);
      }
    };
  }

  // Setup: finish
  if (finishSetupBtn) finishSetupBtn.onclick = onFinishSetup;

  // Tabs
  if (tabCompanies) tabCompanies.onclick = () => showCompaniesScreen();
  if (tabTracked) tabTracked.onclick = () => showTrackedScreen();

  // Refresh buttons
  if (refreshBtn) refreshBtn.onclick = async () => {
    showToast("Refreshing…");
    await refreshAllCompanies();
    renderCompanies();
  };

  if (refreshTrackedBtn) refreshTrackedBtn.onclick = async () => {
    showToast("Rechecking…");
    await refreshAllCompanies();
    renderTracked();
  };

  // Back from company jobs
  if (backBtn) backBtn.onclick = () => showCompaniesScreen();

  // Click-outside to close suggestion dropdowns (single handler)
  document.addEventListener("click", (e) => {
    if (companySuggestions && companySearch) {
      const clickInCompany = companySuggestions.contains(e.target) || e.target === companySearch;
      if (!clickInCompany) companySuggestions.style.display = "none";
    }

    if (roleSuggestions && roleSearch) {
      const clickInRole = roleSuggestions.contains(e.target) || e.target === roleSearch;
      if (!clickInRole) roleSuggestions.style.display = "none";
    }
  });
}

// ===============================
// Boot
// ===============================
(async function init() {
  wireEventsOnce();

  // Load stored state
  const data = await storageGet(["userProfile", "trackedCompanies", "trackedJobs", "companyCache"]);
  userProfile = data.userProfile || null;
  companies = data.trackedCompanies || [];
  trackedJobs = data.trackedJobs || [];
  companyCache = data.companyCache || {};

  updateTrackedTabLabel();

  // Decide which screen
  if (!userProfile || !Array.isArray(userProfile.roles) || userProfile.roles.length === 0 || companies.length === 0) {
    enterSetup(false);
    return;
  }

  enterApp();
  await refreshAllCompanies();
  renderCompanies();
})();

// ===============================
// Setup screen
// ===============================
function enterSetup(prefillFromExisting) {
  if (setupView) setupView.style.display = "block";
  if (appView) appView.style.display = "none";

  // Prefill roles from existing profile (settings flow), else empty.
  setupSelectedRoleKeys = prefillFromExisting && userProfile ? [...(userProfile.roles || [])] : [];
  renderSelectedRoles();

  // Prefill companies list from current in-memory state.
  renderSelectedCompanies();

  // Clear inputs for cleanliness
  if (roleSearch) roleSearch.value = "";
  if (roleSuggestions) {
    roleSuggestions.style.display = "none";
    roleSuggestions.innerHTML = "";
  }

  if (companySearch) companySearch.value = "";
  if (companySuggestions) {
    companySuggestions.style.display = "none";
    companySuggestions.innerHTML = "";
  }
}

async function onFinishSetup() {
  // Validate roles
  if (setupSelectedRoleKeys.length === 0) {
    showToast("Pick at least 1 role");
    return;
  }
  if (setupSelectedRoleKeys.length > MAX_ROLES) {
    showToast(`Max ${MAX_ROLES} roles`);
    return;
  }

  // Validate companies
  if (companies.length === 0) {
    showToast("Add at least 1 company");
    return;
  }
  if (companies.length > MAX_COMPANIES) {
    showToast(`Max ${MAX_COMPANIES} companies`);
    return;
  }

  userProfile = {
    roles: [...setupSelectedRoleKeys],
    createdAt: Date.now(),
  };

  await storageSet({
    userProfile,
    trackedCompanies: companies,
  });

  enterApp();
  await refreshAllCompanies();
  renderCompanies();
}

// ---- Roles: selection + suggestions ----
function addRoleKey(key) {
  if (!key) return;
  if (setupSelectedRoleKeys.includes(key)) {
    showToast("Already selected");
    return;
  }
  if (setupSelectedRoleKeys.length >= MAX_ROLES) {
    showToast(`Max ${MAX_ROLES} roles`);
    return;
  }
  setupSelectedRoleKeys.push(key);
  renderSelectedRoles();
  if (roleSearch) roleSearch.value = "";
  if (roleSuggestions) roleSuggestions.style.display = "none";
}

function removeRoleKey(key) {
  setupSelectedRoleKeys = setupSelectedRoleKeys.filter((k) => k !== key);
  renderSelectedRoles();
}

function renderSelectedRoles() {
  if (!selectedRolesDiv) return;
  selectedRolesDiv.innerHTML = "";

  setupSelectedRoleKeys.forEach((key) => {
    const role = ROLE_OPTIONS.find((r) => r.key === key);
    const label = role ? role.label : key;

    const row = document.createElement("div");
    row.className = "selected-item";
    row.innerHTML = `
      <div><b>${label}</b></div>
      <button class="btn small">Remove</button>
    `;

    row.querySelector("button").onclick = () => removeRoleKey(key);
    selectedRolesDiv.appendChild(row);
  });
}

function renderRoleSuggestions(query) {
  if (!roleSuggestions) return;

  const q = String(query || "").trim().toLowerCase();
  if (!q) {
    roleSuggestions.style.display = "none";
    roleSuggestions.innerHTML = "";
    return;
  }

  const matches = ROLE_OPTIONS
    .filter((r) => r.label.toLowerCase().includes(q) || r.key.includes(q))
    .slice(0, 8);

  roleSuggestions.innerHTML = "";
  if (matches.length === 0) {
    roleSuggestions.style.display = "none";
    return;
  }

  matches.forEach((r) => {
    const row = document.createElement("div");
    row.className = "suggestion";
    row.innerHTML = `<div>${r.label}</div><div class="smallmuted">${r.key}</div>`;
    row.onclick = () => addRoleKey(r.key);
    roleSuggestions.appendChild(row);
  });

  roleSuggestions.style.display = "block";
}

// ---- Companies: suggestions + add/remove ----
function renderCompanySuggestions(query) {
  if (!companySuggestions) return;

  const q = String(query || "").trim().toLowerCase();
  if (!q) {
    companySuggestions.style.display = "none";
    companySuggestions.innerHTML = "";
    return;
  }

  const matches = COMPANY_DIRECTORY
    .filter((c) => c.name.toLowerCase().includes(q) || c.boardSlug.includes(q))
    .slice(0, 10);

  companySuggestions.innerHTML = "";

  if (matches.length > 0) {
    matches.forEach((c) => {
      const row = document.createElement("div");
      row.className = "suggestion";
      row.innerHTML = `<div>${c.name}</div><div class="smallmuted">${c.boardSlug}</div>`;
      row.onclick = () => {
        addCompany(c);
        companySuggestions.style.display = "none";
        if (companySearch) companySearch.value = "";
      };
      companySuggestions.appendChild(row);
    });

    companySuggestions.style.display = "block";
    return;
  }

  // No directory match — offer “add by slug/url” if parseable
  const slug = slugFromGreenhouseInput(query);
  const row = document.createElement("div");
  row.className = "suggestion";

  if (slug) {
    row.innerHTML = `<div>Add "${slug}"</div><div class="smallmuted">Validate Greenhouse board</div>`;
    row.onclick = () => addCompanyFromInput(query);
  } else {
    row.innerHTML = `<div>Paste a Greenhouse board URL</div><div class="smallmuted">or type a board slug (e.g., stripe)</div>`;
    row.onclick = () => showToast("Paste a Greenhouse URL or slug");
  }

  companySuggestions.appendChild(row);
  companySuggestions.style.display = "block";
}

async function addCompanyFromInput(input) {
  if (companies.length >= MAX_COMPANIES) {
    showToast(`Max ${MAX_COMPANIES} companies`);
    return;
  }

  const slug = slugFromGreenhouseInput(input);
  if (!slug) {
    showToast("Paste a Greenhouse board URL or type a slug");
    return;
  }

  // If already added
  if (companies.some((x) => x.boardSlug === slug || x.id === slug)) {
    showToast("Already added");
    return;
  }

  // If exists in directory, add immediately (richer info)
  const found = COMPANY_DIRECTORY.find((c) => c.boardSlug === slug);
  if (found) {
    addCompany(found);
    if (companySearch) companySearch.value = "";
    if (companySuggestions) companySuggestions.style.display = "none";
    return;
  }

  // Unknown slug: validate by calling Greenhouse once.
  showToast("Validating…");

  const res = await sendMessage({
    type: "FETCH_COMPANY_JOBS",
    boardSlug: slug,
    companyName: titleizeSlug(slug),
  });

  if (!res || res.error) {
    showToast("Invalid Greenhouse board slug/URL");
    return;
  }

  const apiName = res.company?.name || titleizeSlug(slug);

  addCompany({
    id: slug,
    name: apiName,
    boardSlug: slug,
    domain: "", // optional; you can fill later
  });

  // Prime cache so the app screen can render immediately
  companyCache[slug] = {
    fetchedAt: Date.now(),
    error: null,
    jobs: res.jobs || [],
    companyName: apiName,
  };

  await storageSet({ companyCache });

  if (companySearch) companySearch.value = "";
  if (companySuggestions) companySuggestions.style.display = "none";
}

function addCompany(c) {
  if (companies.length >= MAX_COMPANIES) {
    showToast(`Max ${MAX_COMPANIES} companies`);
    return;
  }

  if (companies.some((x) => x.id === c.id)) {
    showToast("Already added");
    return;
  }

  companies.push({
    id: c.id,
    name: c.name,
    boardSlug: c.boardSlug,
    domain: c.domain || "",
  });

  renderSelectedCompanies();
}

function removeCompany(companyId) {
  companies = companies.filter((c) => c.id !== companyId);
  renderSelectedCompanies();
}

function renderSelectedCompanies() {
  if (!selectedCompanies) return;
  selectedCompanies.innerHTML = "";

  companies.forEach((c) => {
    const row = document.createElement("div");
    row.className = "selected-item";
    row.innerHTML = `
      <div>
        <div><b>${c.name}</b></div>
        <div class="smallmuted">${c.boardSlug}</div>
      </div>
      <button class="btn small">Remove</button>
    `;
    row.querySelector("button").onclick = () => removeCompany(c.id);
    selectedCompanies.appendChild(row);
  });
}

// ===============================
// App screen
// ===============================
function enterApp() {
  if (setupView) setupView.style.display = "none";
  if (appView) appView.style.display = "block";

  renderProfile();
  showCompaniesScreen();
}

function renderProfile() {
  if (!profileStatus) return;
  const roles = (userProfile?.roles || []).join(", ");
  const comps = companies.map((c) => c.name).join(", ");
  profileStatus.textContent = `Roles: ${roles} · Companies: ${comps}`;
}

function showCompaniesScreen() {
  if (tabCompanies) tabCompanies.classList.add("active");
  if (tabTracked) tabTracked.classList.remove("active");

  if (companiesScreen) companiesScreen.style.display = "block";
  if (companyJobsScreen) companyJobsScreen.style.display = "none";
  if (trackedScreen) trackedScreen.style.display = "none";

  renderCompanies();
}

function showTrackedScreen() {
  if (tabTracked) tabTracked.classList.add("active");
  if (tabCompanies) tabCompanies.classList.remove("active");

  if (companiesScreen) companiesScreen.style.display = "none";
  if (companyJobsScreen) companyJobsScreen.style.display = "none";
  if (trackedScreen) trackedScreen.style.display = "block";

  renderTracked();
}

function updateTrackedTabLabel() {
  if (!tabTracked) return;
  tabTracked.textContent = `Tracked (${trackedJobs.length}/${MAX_TRACKED})`;
}

function showCompanyJobs(companyId) {
  const company = companies.find((c) => c.id === companyId);
  if (!company) return;

  if (tabCompanies) tabCompanies.classList.add("active");
  if (tabTracked) tabTracked.classList.remove("active");

  if (companiesScreen) companiesScreen.style.display = "none";
  if (trackedScreen) trackedScreen.style.display = "none";
  if (companyJobsScreen) companyJobsScreen.style.display = "block";

  if (companyJobsTitle) companyJobsTitle.textContent = company.name;

  const cached = companyCache[companyId];
  const jobs = cached?.jobs || [];
  renderCompanyJobs(company, jobs);
}

// ===============================
// Data refresh + diff
// ===============================
async function refreshAllCompanies() {
  for (const c of companies) {
    const res = await sendMessage({
      type: "FETCH_COMPANY_JOBS",
      boardSlug: c.boardSlug,
      companyName: c.name,
    });

    if (!res || res.error) {
      companyCache[c.id] = {
        fetchedAt: Date.now(),
        error: res?.error || "Fetch failed",
        jobs: [],
        companyName: c.name,
      };
      continue;
    }

    // Update company name from API if present
    const apiName = res.company?.name;
    if (apiName && apiName !== c.name) c.name = apiName;

    const jobs = res.jobs || [];
    companyCache[c.id] = {
      fetchedAt: Date.now(),
      error: null,
      jobs,
      companyName: c.name,
    };

    reconcileTrackedJobsForCompany(c.id, jobs);
  }

  await storageSet({
    trackedCompanies: companies,
    trackedJobs,
    companyCache,
  });

  updateTrackedTabLabel();
  renderProfile();
}

function reconcileTrackedJobsForCompany(companyId, currentJobs) {
  // Index current jobs by id for fast lookup
  const liveMap = new Map();
  (currentJobs || []).forEach((j) => {
    if (j.id != null) liveMap.set(String(j.id), j);
  });

  trackedJobs = trackedJobs.map((t) => {
    if (t.companyId !== companyId) return t;

    const live = liveMap.get(String(t.jobId));
    if (!live) {
      return { ...t, status: "closed", lastCheckedAt: Date.now() };
    }

    const changed =
      (t.title || "") !== (live.title || "") ||
      (t.link || "") !== (live.link || "") ||
      (t.location || "") !== (live.location || "");

    return {
      ...t,
      title: live.title,
      link: live.link,
      location: live.location || "",
      createdAt: live.createdAt,
      status: changed ? "changed" : "open",
      lastCheckedAt: Date.now(),
      lastSeenAt: Date.now(),
    };
  });
}

// ===============================
// Render: Companies
// ===============================
function renderCompanies() {
  if (!companiesList) return;
  companiesList.innerHTML = "";

  companies.forEach((c) => {
    const cache = companyCache[c.id];

    const card = document.createElement("div");
    card.className = "card";

    // Logo
    const logoUrl = getLogoUrl(c.domain);
    const logoEl = logoUrl ? `<img class="logo" src="${logoUrl}" />` : `<div class="logo"></div>`;

    // Error state
    if (cache?.error) {
      card.innerHTML = `
        <div class="company-header">
          ${logoEl}
          <div style="flex:1;">
            <div class="company-name">${c.name}</div>
            <div class="meta">Error fetching jobs</div>
            <div class="pills"><span class="pill error">ERROR</span></div>
          </div>
        </div>
      `;
      card.onclick = () => showCompanyJobs(c.id);
      companiesList.appendChild(card);
      return;
    }

    const jobs = cache?.jobs || [];
    const mostRecent = getMostRecentRelevant(jobs);

    // No relevant roles
    if (!mostRecent) {
      card.innerHTML = `
        <div class="company-header">
          ${logoEl}
          <div style="flex:1;">
            <div class="company-name">${c.name}</div>
            <div class="meta">No relevant roles right now</div>
            <div class="pills"><span class="pill">INACTIVE</span></div>
          </div>
        </div>
      `;
      card.onclick = () => showCompanyJobs(c.id);
      companiesList.appendChild(card);
      return;
    }

    const posted = formatDate(mostRecent.createdAt);
    const pills = [];
    if (isNewJob(mostRecent.createdAt)) pills.push(`<span class="pill new">NEW</span>`);
    pills.push(`<span class="pill">1 role</span>`);

    card.innerHTML = `
      <div class="company-header">
        ${logoEl}
        <div style="flex:1;">
          <div class="company-name">${c.name}</div>
          <div class="job-title">${mostRecent.title}</div>
          <div class="meta">Posted ${posted}</div>
          <div class="pills">${pills.join("")}</div>
        </div>
      </div>
    `;

    card.onclick = () => showCompanyJobs(c.id);
    companiesList.appendChild(card);
  });
}

// ===============================
// Render: Company jobs
// ===============================
function renderCompanyJobs(company, jobs) {
  if (!companyJobsList) return;
  companyJobsList.innerHTML = "";

  const relevant = (jobs || [])
    .filter(isRelevantJob)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (relevant.length === 0) {
    const empty = document.createElement("div");
    empty.className = "jobrow";
    empty.innerHTML = `
      <div class="jobrow-title">No relevant roles</div>
      <div class="jobrow-sub">Try adjusting roles in preferences.</div>
    `;
    companyJobsList.appendChild(empty);
    return;
  }

  relevant.slice(0, 15).forEach((job) => {
    const row = document.createElement("div");
    row.className = "jobrow";

    const alreadyTracked = trackedJobs.some((t) => String(t.jobId) === String(job.id));

    row.innerHTML = `
      <div class="jobrow-title">${job.title}</div>
      <div class="jobrow-sub">Posted ${formatDate(job.createdAt)}${job.location ? ` · ${job.location}` : ""}</div>
      <div class="jobrow-actions">
        <span class="link" data-open="1">Open</span>
        <button class="btn small">${alreadyTracked ? "Tracking" : "Track"}</button>
      </div>
    `;

    row.querySelector("[data-open]").onclick = () => window.open(job.link, "_blank");

    const btn = row.querySelector("button");
    btn.onclick = async () => {
      if (alreadyTracked) return;

      if (trackedJobs.length >= MAX_TRACKED) {
        showToast(`Max ${MAX_TRACKED} tracked jobs`);
        return;
      }

      trackedJobs.push({
        jobId: job.id,
        companyId: company.id,
        companyName: company.name,
        title: job.title,
        link: job.link,
        location: job.location || "",
        createdAt: job.createdAt,
        status: "open",
        lastCheckedAt: Date.now(),
        lastSeenAt: Date.now(),
      });

      await storageSet({ trackedJobs });
      updateTrackedTabLabel();
      showToast("Tracked");
      renderCompanyJobs(company, jobs); // refresh list to show “Tracking”
    };

    companyJobsList.appendChild(row);
  });
}

// ===============================
// Render: Tracked
// ===============================
function renderTracked() {
  if (!trackedList) return;
  trackedList.innerHTML = "";

  if (trackedJobs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "jobrow";
    empty.innerHTML = `
      <div class="jobrow-title">No tracked jobs yet</div>
      <div class="jobrow-sub">Open a company and click Track.</div>
    `;
    trackedList.appendChild(empty);
    return;
  }

  trackedJobs.forEach((t) => {
    const row = document.createElement("div");
    row.className = "jobrow";

    const status = t.status || "open";
    const pillClass = status === "closed" ? "closed" : status === "changed" ? "changed" : "open";
    const checked = t.lastCheckedAt ? new Date(t.lastCheckedAt).toLocaleString() : "—";

    row.innerHTML = `
      <div class="row space">
        <div class="jobrow-title">${t.companyName || t.companyId}</div>
        <span class="pill ${pillClass}">${status.toUpperCase()}</span>
      </div>
      <div class="jobrow-sub">${t.title}</div>
      <div class="jobrow-sub">Last checked: ${checked}</div>
      <div class="jobrow-actions">
        <span class="link" data-open="1">Open</span>
        <button class="btn small">Remove</button>
      </div>
    `;

    row.querySelector("[data-open]").onclick = () => window.open(t.link, "_blank");
    row.querySelector("button").onclick = async () => {
      trackedJobs = trackedJobs.filter((x) => String(x.jobId) !== String(t.jobId));
      await storageSet({ trackedJobs });
      updateTrackedTabLabel();
      renderTracked();
    };

    trackedList.appendChild(row);
  });
}
