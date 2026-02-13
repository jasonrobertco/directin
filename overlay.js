// overlay.js
// -----------------------------------------------------------------------------
// DirectIn — Overlay UI Controller (runs inside overlay.html iframe)
//
// Key change:
// - Roles are now "alert keywords" (free-text queries) instead of selecting existing job titles.
// - Matching is token-based with light synonym support and a score threshold.
// - Company cards show: most recent matched role + count of matched roles.
// - Company detail shows matched roles sorted by recency and indicates best-matching query.
//
// Storage (chrome.storage.local):
// - userProfile: { roleQueries: ["software engineer intern", ...], companies: [{...}], createdAt }
// - trackedJobs: [{jobId, companyId, ... status ... }]
// - companyCache: { [companyId]: { fetchedAt, error, jobs, companyName } }
// -----------------------------------------------------------------------------

// ===============================
// Storage + messaging helpers
// ===============================

function formatMD(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getMonth() + 1}/${d.getDate()}`; // no leading zeros
}

function resolveJobDates(job) {
  const seenAt = job?.firstSeenAt ?? null;

  const freshnessAt =
    job?.providerUpdatedAt ??
    job?.lastChangedAt ??
    job?.lastFetchedAt ??
    null;

  return { seenAt, freshnessAt };
}


function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

function sendMessage(msg) {
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

// Alert keywords (setup)
const roleSearch = document.getElementById("roleSearch");
const roleSuggestions = document.getElementById("roleSuggestions");
const selectedRolesDiv = document.getElementById("selectedRoles");

// Companies (setup)
const companySearch = document.getElementById("companySearch");
const addCompanyBtn = document.getElementById("addCompanyBtn");
const companySuggestions = document.getElementById("companySuggestions");
const selectedCompanies = document.getElementById("selectedCompanies");
const finishSetupBtn = document.getElementById("finishSetupBtn");
const goBigTechBtn = document.getElementById("goBigTechBtn");

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
// Storage keys
const STORAGE_PROFILE_KEY = "userProfile";
const STORAGE_CACHE_KEY = "companyCache";
const STORAGE_TRACKED_KEY = "trackedJobs";

const MAX_QUERIES = 3;
const MAX_COMPANIES = 10;
const MAX_TRACKED = 5;
const NEW_DAYS = 7;

// FOR TESTING: Set to true to always show setup screen on refresh
const FORCE_SETUP = false;

// Matching
const MATCH_THRESHOLD = 0.75; // 75% token coverage counts as a match

// Templates (student/early-career biased). Users can still type anything.
const ROLE_TEMPLATES = [
  "Software Engineer Intern",
  "SWE Intern",
  "Backend Intern",
  "Frontend Intern",
  "Full Stack Intern",
  "Data Engineer Intern",
  "Data Scientist Intern",
  "ML Engineer Intern",
  "Machine Learning Intern",
  "Embedded Intern",
  "Hardware Intern",
  "New Grad Software Engineer",
  "University Graduate Software Engineer",
  "Early Career Software Engineer",
];

// Small built-in directory (extend anytime).
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
let userProfile = null;              // { roleQueries: [], companies: [], createdAt }
let companies = [];                  // [{ id, name, boardSlug, domain }]
let roleQueries = [];                // ["software engineer intern", ...] from userProfile
let trackedJobs = [];                // [{ jobId, companyId, status, ... }]
let companyCache = {};               // companyId -> { fetchedAt, error, jobs, companyName }

// Setup-only state
let setupSelectedQueries = [];       // ["software engineer intern", ...], up to MAX_QUERIES
let settingsMode = false; // true when setup opened from ⚙
// ===============================
// UI utilities
// ===============================
function showToast(msg) {
  if (!toast) return;
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

function formatShortDate(iso) {
  if (!iso) return "—";
  let d;
  // Greenhouse sometimes returns epoch seconds/ms as string/number
  if (typeof iso === "number") {
    d = new Date(iso > 1e12 ? iso : iso * 1000);
  } else if (/^\d+$/.test(String(iso))) {
    const n = Number(iso);
    d = new Date(n > 1e12 ? n : n * 1000);
  } else {
    d = new Date(iso);
  }
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}


function normalizeDomain(domain) {
  const d = String(domain || "").trim().toLowerCase();
  if (!d) return "";
  return d.replace(/^https?:\/\//, "").split("/")[0];
}

function getLogoUrl(domain) {
  const d = normalizeDomain(domain);
  if (!d) return null;

  // Small + reliable favicon fetch (cached by browser)
  return `https://www.google.com/s2/favicons?sz=64&domain_url=${encodeURIComponent("https://" + d)}`;
}

function attachLogoFallback(cardEl, companyName) {
  const img = cardEl.querySelector("img.logo");
  if (!img) return;

  img.referrerPolicy = "no-referrer";
  img.loading = "lazy";

  img.onerror = () => {
    const fallback = document.createElement("div");
    fallback.className = "logo fallback";
    fallback.textContent = (companyName || "?").trim().charAt(0).toUpperCase();
    img.replaceWith(fallback);
  };
}


// Parse either a slug ("stripe") OR a Greenhouse URL.
function slugFromGreenhouseInput(text) {
  const t = String(text || "").trim();
  if (!t) return null;

  if (/^[a-z0-9-]+$/i.test(t) && !t.includes("http")) return t.toLowerCase();

  try {
    const u = new URL(t);
    if (!u.hostname.includes("greenhouse.io")) return null;

    const parts = u.pathname.split("/").filter(Boolean);

    if (parts[0] === "v1" && parts[1] === "boards" && parts[2]) return parts[2].toLowerCase();
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

// ===============================
// Profile migration (legacy -> new)
// ===============================
function migrateProfile(p) {
  if (!p) return null;

  // Already new format
  if (Array.isArray(p.roleQueries)) return p;

  // Legacy format: { roles: ["swe","intern",...], createdAt }
  if (Array.isArray(p.roles)) {
    const q = [];
    const roles = p.roles;

    if (roles.includes("intern")) q.push("Software Engineer Intern");
    if (roles.includes("swe")) q.push("Software Engineer");
    if (roles.includes("ml")) q.push("Machine Learning Intern");

    return {
      roleQueries: q.length > 0 ? q : ["Software Engineer"],
      companies: p.companies || [],
      createdAt: p.createdAt || Date.now(),
    };
  }

  return null;
}

// ===============================
// Matching logic
// ===============================
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

function expandAbbrev(normStr) {
  return String(normStr || "")
    .replace(/\bswe\b/g, "software engineer")
    .replace(/\bsde\b/g, "software engineer")
    .replace(/\bml\b/g, "machine learning");
}

function expandQuery(q) {
  return expandAbbrev(normalize(q));
}

function tokenize(s) {
  const n = expandAbbrev(normalize(s));
  return n ? n.split(" ").filter(Boolean) : [];
}

function hasSeniority(titleNorm) {
  return SENIORITY_BLOCKLIST.some((w) => titleNorm.includes(w));
}

function titleTokenSet(title) {
  const t = expandAbbrev(normalize(title));
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
  const titleNorm = expandAbbrev(normalize(title));
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

  let score = matched / qTokens.length;

  const qNorm = expandAbbrev(normalize(query));
  if (qNorm && titleNorm.includes(qNorm)) score = Math.min(1, score + 0.1);

  return score;
}

function bestMatchForJobTitle(title, roleQueries) {
  const queries = Array.isArray(roleQueries) ? roleQueries : [];
  if (!queries.length) return { score: 0, query: null };

  let best = { score: 0, query: null };
  for (const q of queries) {
    const s = scoreTitleAgainstQuery(title, q);
    if (s > best.score) best = { score: s, query: q };
  }
  return best;
}

function getRelevantMatches(jobs, roleQueries) {
  return jobs
    .map((job) => {
      const match = bestMatchForJobTitle(job.title, roleQueries);
      return { job, match };
    })
    .filter((x) => x.match.score >= MATCH_THRESHOLD)
    .sort((a, b) => {
      const dateA = a.job.createdAt ? new Date(a.job.createdAt).getTime() : 0;
      const dateB = b.job.createdAt ? new Date(b.job.createdAt).getTime() : 0;
      return dateB - dateA;
    });
}

// ===============================
// Wire up static events (run once)
// ===============================
function wireEventsOnce() {
  // Window messaging
  minimizeBtn?.addEventListener("click", () => {
    window.parent?.postMessage({ type: "GOL_MINIMIZE" }, "*");
  });

  expandBtn?.addEventListener("click", () => {
    window.parent?.postMessage({ type: "GOL_TOGGLE_EXPAND" }, "*");
  });

  settingsBtn?.addEventListener("click", () => {
    enterSetup(true);
    renderSelectedQueries();
    renderSelectedCompanies();
  });

  // Tabs
  tabCompanies?.addEventListener("click", () => showCompaniesScreen());
  tabTracked?.addEventListener("click", () => showTrackedScreen());

  // Main screens
  backBtn?.addEventListener("click", () => showCompaniesScreen());
  refreshBtn?.addEventListener("click", () => {
    refreshAllCompanies().then(() => renderCompanies());
  });

  refreshTrackedBtn?.addEventListener("click", async () => {
    await refreshAllCompanies();
    renderTracked();
    showToast("Rechecked");
  });

  // Setup events
  finishSetupBtn?.addEventListener("click", () => onFinishSetup());

  roleSearch?.addEventListener("input", (e) => {
    const val = e.target?.value || "";
    if (val.length >= 2) renderRoleSuggestions(val);
    else if (roleSuggestions) roleSuggestions.style.display = "none";
  });

  roleSearch?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    addQueryFromInput(e.target?.value || "");
  });

  companySearch?.addEventListener("input", (e) => {
    const val = e.target?.value || "";
    if (val.length >= 1) renderCompanySuggestions(val);
    else if (companySuggestions) companySuggestions.style.display = "none";
  });

  addCompanyBtn?.addEventListener("click", () => {
    addCompanyFromInput(companySearch?.value || "");
  });

  companySearch?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    addCompanyFromInput(e.target?.value || "");
  });
}

// ===============================
// Init (boot)
// ===============================
(async function init() {
  console.log("[DirectIn] overlay init start");

  try {
    wireEventsOnce();

    const data = await storageGet([STORAGE_PROFILE_KEY, STORAGE_CACHE_KEY, STORAGE_TRACKED_KEY]);

    userProfile = data[STORAGE_PROFILE_KEY] || null;
    companyCache = data[STORAGE_CACHE_KEY] || {};
    trackedJobs = data[STORAGE_TRACKED_KEY] || [];

    // Migrate old profile format if needed
    userProfile = migrateProfile(userProfile);

    companies = Array.isArray(userProfile?.companies) ? userProfile.companies : [];
    roleQueries = Array.isArray(userProfile?.roleQueries) ? userProfile.roleQueries : [];

    renderSelectedCompanies();
    renderSelectedQueries();
    updateTrackedTabLabel();

    // FOR TESTING: Force setup screen to appear
    if (FORCE_SETUP) {
      enterSetup(false);
      return;
    }

    // Decide view
    if (!companies.length || !roleQueries.length) {
      enterSetup(false);
    } else {
      enterApp();
      await refreshAllCompanies();
      renderCompanies();
    }

    console.log("[DirectIn] overlay init done");
  } catch (err) {
    console.error("[DirectIn] overlay init failed", err);

    // Never leave it blank
    if (typeof enterSetup === "function") enterSetup(false);
    else {
      if (setupView) setupView.style.display = "block";
      if (appView) appView.style.display = "none";
    }

    showToast("DirectIn failed to load. Open console for error.");
  }
})();


// ===============================
// Setup screen
// ===============================
function enterSetup(prefillFromExisting) {
  settingsMode = !!prefillFromExisting;
  if (setupView) setupView.style.display = "block";
  if (appView) appView.style.display = "none";

  if (!prefillFromExisting) {
    setupSelectedQueries = [];
    companies = [];
  } else {
    setupSelectedQueries = [...roleQueries];
    companies = Array.isArray(userProfile?.companies) ? [...userProfile.companies] : [];
  }

  renderSelectedQueries();
  renderSelectedCompanies();

  if (roleSearch) roleSearch.value = "";
  if (companySearch) companySearch.value = "";
  if (roleSuggestions) roleSuggestions.style.display = "none";
  if (companySuggestions) companySuggestions.style.display = "none";
}

// ---- Queries: add / remove / render ----
function addQueryFromInput(input) {
  const val = String(input || "").trim();
  if (!val) return;

  if (setupSelectedQueries.includes(val)) {
    showToast("Already added");
    return;
  }

  if (setupSelectedQueries.length >= MAX_QUERIES) {
    showToast(`Max ${MAX_QUERIES} alert keywords`);
    return;
  }

  setupSelectedQueries.push(val);
  renderSelectedQueries();

  if (roleSearch) roleSearch.value = "";
  if (roleSuggestions) roleSuggestions.style.display = "none";
}

function removeQuery(q) {
  setupSelectedQueries = setupSelectedQueries.filter((x) => x !== q);
  renderSelectedQueries();
}

function renderSelectedQueries() {
  if (!selectedRolesDiv) return;
  selectedRolesDiv.innerHTML = "";

  setupSelectedQueries.forEach((q) => {
    const item = document.createElement("div");
    item.className = "selected-item";
    item.innerHTML = `
      <div>
        <div class="name">${q}</div>
      </div>
      <button>Remove</button>
    `;
    item.querySelector("button")?.addEventListener("click", () => removeQuery(q));
    selectedRolesDiv.appendChild(item);
  });
}

function renderRoleSuggestions(query) {
  if (!roleSuggestions) return;

  const q = String(query || "").trim().toLowerCase();
  if (!q) {
    roleSuggestions.style.display = "none";
    return;
  }

  const matches = ROLE_TEMPLATES.filter((t) => {
    const tl = t.toLowerCase();
    const ql = q.toLowerCase();
    return tl.includes(ql) || ql.includes(tl);
  });

  if (!matches.length) {
    roleSuggestions.style.display = "none";
    return;
  }

  roleSuggestions.innerHTML = "";
  matches.forEach((t) => {
    const row = document.createElement("div");
    row.className = "suggestion";
    row.textContent = t;
    row.onclick = () => {
      addQueryFromInput(t);
    };
    roleSuggestions.appendChild(row);
  });

  roleSuggestions.style.display = "block";
}

async function onFinishSetup() {
  if (setupSelectedQueries.length === 0) {
    showToast("Add at least 1 alert keyword");
    return;
  }
  if (setupSelectedQueries.length > MAX_QUERIES) {
    showToast(`Max ${MAX_QUERIES} alert keywords`);
    return;
  }

  if (companies.length === 0) {
    showToast("Add at least 1 company");
    return;
  }
  if (companies.length > MAX_COMPANIES) {
    showToast(`Max ${MAX_COMPANIES} companies`);
    return;
  }

  // FIX: Save companies INSIDE userProfile object
  userProfile = {
    roleQueries: [...setupSelectedQueries],
    companies: [...companies],  // ← Companies now saved inside userProfile
    createdAt: userProfile?.createdAt || Date.now(),
  };

  await storageSet({
    [STORAGE_PROFILE_KEY]: userProfile,
  });

  // Also update the in-memory references
  roleQueries = [...setupSelectedQueries];

  enterApp();
  await refreshAllCompanies();

  // Post-setup summary (closest matches + newest date)
  const summary = computeMatchSummary();
  if (summary.total > 0) {
    showToast(`Found ${summary.total} matches · newest ${formatDate(summary.newest)}`);
  } else {
    showToast("No matches right now (we'll catch future posts)");
  }

  renderCompanies();
}

// ---- Companies: suggestions + add/remove ----
function renderCompanySuggestions(query) {
  if (!companySuggestions) return;

  const q = String(query || "").trim().toLowerCase();
  if (!q) {
    companySuggestions.style.display = "none";
    return;
  }

  const inDirectory = COMPANY_DIRECTORY.filter(
    (c) => c.name.toLowerCase().includes(q) || c.boardSlug.toLowerCase().includes(q)
  );

  const alreadyAdded = new Set(companies.map((c) => c.id));
  const filtered = inDirectory.filter((c) => !alreadyAdded.has(c.id));

  const slug = slugFromGreenhouseInput(q);
  const isValidSlug = slug && !/\s/.test(slug) && slug.length >= 2;

  if (!filtered.length && !isValidSlug) {
    companySuggestions.style.display = "none";
    return;
  }

  companySuggestions.innerHTML = "";

  filtered.forEach((c) => {
    const row = document.createElement("div");
    row.className = "suggestion";
    row.innerHTML = `<span>${c.name}</span><span class="smallmuted">${c.boardSlug}</span>`;
    row.onclick = () => addCompany(c);
    companySuggestions.appendChild(row);
  });

  if (isValidSlug && !alreadyAdded.has(slug)) {
    const row = document.createElement("div");
    row.className = "suggestion";
    row.innerHTML = `<span>Custom: ${titleizeSlug(slug)}</span><span class="smallmuted">${slug}</span>`;
    row.onclick = () => {
      const c = { id: slug, name: titleizeSlug(slug), boardSlug: slug, domain: "" };
      addCompany(c);
    };
    companySuggestions.appendChild(row);
  }

  companySuggestions.style.display = "block";
}

async function addCompanyFromInput(input) {
  const val = String(input || "").trim();
  if (!val) return;

  const existing = COMPANY_DIRECTORY.find(
    (c) => c.name.toLowerCase() === val.toLowerCase() || c.boardSlug.toLowerCase() === val.toLowerCase()
  );

  if (existing) {
    await addCompany(existing);
    return;
  }

  const slug = slugFromGreenhouseInput(val);
  if (!slug) {
    showToast("Enter a valid Greenhouse board slug or URL");
    return;
  }

  if (companies.some((c) => c.id === slug)) {
    showToast("Already added");
    return;
  }

  if (companies.length >= MAX_COMPANIES) {
    showToast(`Max ${MAX_COMPANIES} companies`);
    return;
  }

  showToast("Verifying board...");

  try {
    const res = await sendMessage({
      type: "FETCH_COMPANY_JOBS",
      boardSlug: slug,
      companyName: titleizeSlug(slug),
    });

    if (res?.error) throw new Error(res.error);

    const c = {
      id: slug,
      name: res.company?.name || titleizeSlug(slug),
      boardSlug: slug,
      domain: "",
    };

    await addCompany(c);

    companyCache[c.id] = {
      companyName: c.name,
      jobs: res.jobs || [],
      fetchedAt: Date.now(),
      error: null,
    };

    await storageSet({ companyCache });
  } catch (err) {
    showToast(String(err));
  }

  if (companySearch) companySearch.value = "";
  if (companySuggestions) companySuggestions.style.display = "none";
}

async function addCompany(c) {
  if (companies.some((x) => x.id === c.id)) {
    showToast("Already added");
    return;
  }

  if (companies.length >= MAX_COMPANIES) {
    showToast(`Max ${MAX_COMPANIES} companies`);
    return;
  }

  companies.push(c);
  await persistCompanyEdits();
  renderSelectedCompanies();

  if (companySearch) companySearch.value = "";
  if (companySuggestions) companySuggestions.style.display = "none";
}

async function persistCompanyEdits() {
  // FIX: Update companies in userProfile before saving
  if (userProfile) {
    userProfile.companies = [...companies];
  }
  await storageSet({ [STORAGE_PROFILE_KEY]: userProfile });
}

async function removeCompany(companyId) {
  companies = companies.filter((c) => c.id !== companyId);
  await persistCompanyEdits();
  renderSelectedCompanies();

  trackedJobs = trackedJobs.filter((t) => t.companyId !== companyId);
  await storageSet({ trackedJobs });

  delete companyCache[companyId];
  await storageSet({ companyCache });

  updateTrackedTabLabel();
}

function quickAddBigTech() {
  const tech = COMPANY_DIRECTORY.slice(0, 5);
  const toAdd = tech.filter((c) => !companies.some((x) => x.id === c.id));

  if (!toAdd.length) {
    showToast("Big tech already added!");
    return;
  }

  toAdd.forEach((c) => {
    if (companies.length >= MAX_COMPANIES) return;
    companies.push(c);
  });

  persistCompanyEdits().then(() => {
    renderSelectedCompanies();
    showToast(`Added ${toAdd.length} companies`);
  });
}

function renderSelectedCompanies() {
  if (!selectedCompanies) return;
  selectedCompanies.innerHTML = "";

  companies.forEach((c) => {
    const item = document.createElement("div");
    item.className = "selected-item";
    item.innerHTML = `
      <div>
        <div class="name">${c.name}</div>
        <div class="slug">${c.boardSlug}</div>
      </div>
      <button>Remove</button>
    `;
    item.querySelector("button")?.addEventListener("click", () => removeCompany(c.id));
    selectedCompanies.appendChild(item);
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
  const q = roleQueries.length;
  const c = companies.length;
  profileStatus.textContent = `Tracking ${c} ${c === 1 ? "company" : "companies"} · ${q} ${q === 1 ? "keyword" : "keywords"}`;
}

function showCompaniesScreen() {
  if (companiesScreen) companiesScreen.style.display = "block";
  if (companyJobsScreen) companyJobsScreen.style.display = "none";
  if (trackedScreen) trackedScreen.style.display = "none";

  if (tabCompanies) tabCompanies.classList.add("active");
  if (tabTracked) tabTracked.classList.remove("active");

  renderCompanies();
}

function showTrackedScreen() {
  if (companiesScreen) companiesScreen.style.display = "none";
  if (companyJobsScreen) companyJobsScreen.style.display = "none";
  if (trackedScreen) trackedScreen.style.display = "block";

  if (tabCompanies) tabCompanies.classList.remove("active");
  if (tabTracked) tabTracked.classList.add("active");

  renderTracked();
}

function updateTrackedTabLabel() {
  if (!tabTracked) return;
  tabTracked.textContent = `Tracked (${trackedJobs.length}/${MAX_TRACKED})`;
}

function showCompanyJobs(companyId) {
  const company = companies.find((c) => c.id === companyId);
  if (!company) return;

  const cache = companyCache[companyId];
  const jobs = cache?.jobs || [];

  if (companiesScreen) companiesScreen.style.display = "none";
  if (trackedScreen) trackedScreen.style.display = "none";
  if (companyJobsScreen) companyJobsScreen.style.display = "block";

  if (companyJobsTitle) companyJobsTitle.textContent = company.name;

  renderCompanyJobs(company, jobs);
}


function contentHashForJob(job) {
  // hash the displayed content (keep stable, don’t include volatile timestamps)
  const s = `${job.title || ""}|${job.location || ""}|${job.url || job.link || ""}`;
  // lightweight hash (fine for change detection)
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return String(h);
}

function ingestJobs({ companyId, provider, fetchedJobs, prevJobs }) {
  const now = Date.now();

  const prevById = new Map((prevJobs || []).map(j => [j.id, j]));
  const next = [];

  for (const fj of fetchedJobs || []) {
    const stableId = fj.id ?? `${provider}:${companyId}:${fj.jobId ?? fj.id}`;
    const prev = prevById.get(stableId);

    const base = {
      ...fj,
      id: stableId,
      providerUpdatedAt: fj.providerUpdatedAt ?? null,
    };

    const nextHash = contentHashForJob(base);

    const out = {
      ...base,
      firstSeenAt: prev?.firstSeenAt ?? now,
      lastFetchedAt: now,
      contentHash: nextHash,
      lastChangedAt:
        prev && prev.contentHash && prev.contentHash !== nextHash
          ? now
          : (prev?.lastChangedAt ?? null),
    };

    next.push(out);
  }

  return next;
}

async function refreshAllCompanies() {
  for (const c of companies) {
    try {
      const res = await sendMessage({
        type: "FETCH_COMPANY_JOBS",
        boardSlug: c.boardSlug,
        companyName: c.name,
      });

      if (res?.error) {
        companyCache[c.id] = {
          companyName: c.name,
          jobs: [],
          fetchedAt: Date.now(),
          error: String(res.error),
        };
      } else {
        const prevJobs = companyCache[c.id]?.jobs || [];
        const provider = "greenhouse"; // or c.provider if you store it

        const jobs = ingestJobs({
          companyId: c.id,
          provider,
          fetchedJobs: res.jobs || [],
          prevJobs,
        });

        companyCache[c.id] = {
          companyName: res.company?.name || c.name,
          jobs,
          fetchedAt: Date.now(),
          error: null,
        };


        reconcileTrackedJobsForCompany(c.id, jobs);
      }
    } catch (err) {
      companyCache[c.id] = {
        companyName: c.name,
        jobs: [],
        fetchedAt: Date.now(),
        error: String(err),
      };
    }
  }

  await storageSet({ companyCache, trackedJobs });
}

function reconcileTrackedJobsForCompany(companyId, currentJobs) {
  const liveMap = new Map();
  currentJobs.forEach((j) => liveMap.set(String(j.id), j));

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

function computeMatchSummary() {
  const queries = userProfile?.roleQueries || [];
  let total = 0;
  let newest = null;

  for (const c of companies) {
    const jobs = companyCache[c.id]?.jobs || [];
    const matches = getRelevantMatches(jobs, queries);
    total += matches.length;

    if (matches.length > 0) {
      const top = matches[0].job?.createdAt;
      if (top && (!newest || new Date(top) > new Date(newest))) newest = top;
    }
  }

  return { total, newest };
}

// ===============================
// Render: Companies
// ===============================


function renderCompanies() {
  if (!companiesList) return;
  companiesList.innerHTML = "";

  const queries = userProfile?.roleQueries || [];

  companies.forEach((c) => {
    const cache = companyCache[c.id];
    const card = document.createElement("div");
    card.className = "card dm-card";

    const logoUrl = getLogoUrl(c.domain);
    const initial = (c.name || "?").trim().charAt(0).toUpperCase();
    const logoEl = logoUrl
      ? `<img class="logo" src="${logoUrl}" />`
      : `<div class="logo fallback">${initial}</div>`;

    // Base skeleton
    const header = (bodyHtml, pillHtml, showDot) => {
      const dotCls = showDot ? "unread-dot" : "unread-dot hidden";
      return `
        <div class="dm-row">
          <div class="dm-left">
            <span class="${dotCls}"></span>
            <div class="dm-avatar">${logoEl}</div>
          </div>
          <div class="dm-main">
            <div class="dm-top">
              <div class="dm-name">${c.name}</div>
              <div class="dm-chevron">›</div>
            </div>
            <div class="dm-sub">
              ${pillHtml || ""}
              ${bodyHtml || ""}
            </div>
          </div>
        </div>
      `;
    };

    // Unsupported / link-only
    if (cache?.error === "UNSUPPORTED_PROVIDER") {
      const pill = `<span class="pill muted">LINK</span>`;
      card.innerHTML = header(`<span class="dm-text">Not supported yet</span>`, pill, false);
      card.onclick = () => {
        if (c.careersUrl) window.open(c.careersUrl, "_blank");
      };
      attachLogoFallback(card, c.name);
      companiesList.appendChild(card);
      return;
    }

    // Real fetch error
    if (cache?.error) {
      const pill = `<span class="pill error">ERROR</span>`;
      card.innerHTML = header(`<span class="dm-text">Error fetching jobs</span>`, pill, false);
      card.onclick = () => showCompanyJobs(c.id);
      attachLogoFallback(card, c.name);
      companiesList.appendChild(card);
      return;
    }

    const jobs = cache?.jobs || [];
    const matches = getRelevantMatches(jobs, queries);

    if (matches.length === 0) {
      const pill = `<span class="pill">INACTIVE</span>`;
      card.innerHTML = header(`<span class="dm-text">No matches right now</span>`, pill, false);
      card.onclick = () => showCompanyJobs(c.id);
      attachLogoFallback(card, c.name);
      companiesList.appendChild(card);
      return;
    }

    // Matches: show unread dot ALWAYS on this screen when there are matches
    const mostRecent = matches[0];
    const posted = formatShortDate(mostRecent.job.createdAt);
    const queryLabel = mostRecent.match.query || "—";

    const pill = `<span class="pill dm-pill">${matches.length} roles</span>`;
    const line = `<span class="dm-preview">${queryLabel} · ${posted}</span>`;

    card.innerHTML = header(line, pill, true);
    card.onclick = () => showCompanyJobs(c.id);
    attachLogoFallback(card, c.name);
    companiesList.appendChild(card);
  });
}



// ===============================
// Render: Company jobs (matched roles)
// ===============================
function renderCompanyJobs(company, jobs) {
  if (!companyJobsList) return;
  companyJobsList.innerHTML = "";

  const queries = userProfile?.roleQueries || [];
  const matches = getRelevantMatches(jobs || [], queries);

  if (matches.length === 0) {
    const empty = document.createElement("div");
    empty.className = "jobrow";
    empty.innerHTML = `
      <div class="jobrow-title">No matches</div>
      <div class="jobrow-sub">Try adjusting alert keywords in preferences.</div>
    `;
    companyJobsList.appendChild(empty);
    return;
  }

  matches.slice(0, 15).forEach(({ job, match }) => {
    const row = document.createElement("div");
    row.className = "jobrow";
    row.style.position = "relative"; // for top-right Seen timestamp

    const alreadyTracked = trackedJobs.some((t) => String(t.jobId) === String(job.id));
    const scorePct = Math.round(match.score * 100);

    const { seenAt, freshnessAt } = resolveJobDates(job);
    const seenText = `Seen: ${formatMD(seenAt)}`;
    const titleText = `${job.title} • ${formatMD(freshnessAt)}`;

    row.innerHTML = `
      <div class="jobrow-title">${titleText}</div>

      <div class="jobrow-seen" style="
        position:absolute;
        top:10px;
        right:12px;
        font-size:12px;
        color: var(--text-secondary);
        font-weight:500;
      ">${seenText}</div>

      <div class="jobrow-sub">
        Matched: ${match.query || "—"} · ${scorePct}%${job.location ? ` · ${job.location}` : ""}
      </div>

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
        createdAt: job.createdAt, // keep for legacy display if needed
        status: "open",
        lastCheckedAt: Date.now(),
        lastSeenAt: Date.now(),
      });

      await storageSet({ trackedJobs });
      updateTrackedTabLabel();
      showToast("Tracked");
      renderCompanyJobs(company, jobs);
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