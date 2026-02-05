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
// - userProfile: { roleQueries: ["software engineer intern", ...], createdAt }
// - trackedCompanies: [{id,name,boardSlug,domain}]
// - trackedJobs: [{jobId, companyId, ... status ... }]
// - companyCache: { [companyId]: { fetchedAt, error, jobs, companyName } }
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
const MAX_QUERIES = 3;
const MAX_COMPANIES = 3;
const MAX_TRACKED = 5;
const NEW_DAYS = 7;

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
let userProfile = null;              // { roleQueries: [], createdAt }
let companies = [];                  // [{ id, name, boardSlug, domain }]
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


// Parse either a slug (“stripe”) OR a Greenhouse URL.
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
    if (roles.includes("data")) q.push("Data Engineer Intern");
    if (roles.includes("hardware")) q.push("Embedded Intern");

    return { roleQueries: q.slice(0, MAX_QUERIES), createdAt: p.createdAt || Date.now() };
  }

  return p;
}

// ===============================
// Matching (token scoring + synonyms)
// ===============================
const SENIORITY_BLOCKLIST = ["senior", "staff", "principal", "lead", "manager", "director", "head"];

const TOKEN_ALIASES = {
  engineer: ["engineer", "engineering"],
  engineering: ["engineering", "engineer"],
  intern: ["intern", "internship"],
  internship: ["internship", "intern"],
  grad: ["grad", "graduate"],
  graduate: ["graduate", "grad"],
  swe: ["swe"], // handled via query expansion (below)
  ml: ["ml"],   // handled via query expansion (below)
};

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function expandQuery(q) {
  // Expand common abbreviations before tokenizing
  let s = normalize(q);

  // SWE / SDE -> software engineer
  s = s.replace(/\bswe\b/g, "software engineer");
  s = s.replace(/\bsde\b/g, "software engineer");

  // ML -> machine learning
  s = s.replace(/\bml\b/g, "machine learning");

  // New grad variants (keep both terms so token aliases can hit)
  s = s.replace(/\bnew grad\b/g, "new grad");
  s = s.replace(/\buniversity grad\b/g, "university grad");
  s = s.replace(/\bearly career\b/g, "early career");

  return s;
}

function tokenize(s) {
  const n = normalize(s);
  if (!n) return [];
  return n.split(" ").filter(Boolean);
}

function hasSeniority(titleNorm) {
  return SENIORITY_BLOCKLIST.some((w) => titleNorm.includes(w));
}

function titleTokenSet(title) {
  const t = normalize(title);
  return new Set(t ? t.split(" ") : []);
}

function tokenMatchesTitle(token, tset) {
  if (!tset || typeof tset.has !== 'function') return false;
  const aliases = TOKEN_ALIASES[token] || [token];
  return aliases.some((a) => {
    const an = normalize(a);
    if (!an) return false;
    // alias might be multiword after normalize; all words must appear
    const parts = an.split(" ").filter(Boolean);
    return parts.every((p) => tset.has(p));
  });
}

function scoreTitleAgainstQuery(title, query) {
  if (!title || !query) return { score: 0, matched: 0, total: 0, query: query || "" };
  
  const titleNorm = normalize(title);
  const tset = titleTokenSet(title);

  const qExpanded = expandQuery(query);
  const qTokensRaw = tokenize(qExpanded);

  // Remove ultra-common noise tokens (optional)
  const qTokens = qTokensRaw.filter((w) => !["and", "of", "the", "a", "an", "to", "for"].includes(w));

  if (qTokens.length === 0) return { score: 0, matched: 0, total: 0, query: query };

  // Student-targeted: block senior/management titles always
  if (hasSeniority(titleNorm)) return { score: 0, matched: 0, total: qTokens.length, query: query };

  let matched = 0;
  for (const tok of qTokens) {
    if (tokenMatchesTitle(tok, tset)) matched += 1;
  }

  let score = matched / qTokens.length;

  // Small bonus if the whole normalized query appears as a substring
  const qNorm = normalize(qExpanded);
  if (qNorm && titleNorm.includes(qNorm)) score = Math.min(1, score + 0.1);

  return { score, matched, total: qTokens.length, query: query };
}

function bestMatchForJobTitle(title, roleQueries) {
  const queries = Array.isArray(roleQueries) ? roleQueries : [];
  if (queries.length === 0) return { score: 1, query: "" };

  let best = { score: 0, query: "" };
  for (const q of queries) {
    const s = scoreTitleAgainstQuery(title, q);
    if (s.score > best.score) best = { score: s.score, query: s.query };
  }
  return best;
}

function getRelevantMatches(jobs, roleQueries) {
  const out = [];
  for (const j of (jobs || [])) {
    const title = String(j.title || "");
    const best = bestMatchForJobTitle(title, roleQueries);
    if (best.score >= MATCH_THRESHOLD) out.push({ job: j, match: best });
  }
  // newest first
  out.sort((a, b) => new Date(b.job.createdAt) - new Date(a.job.createdAt));
  return out;
}

// ===============================
// One-time event wiring
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

  // Setup: alert keyword behaviors
  if (roleSearch) {
    roleSearch.oninput = () => renderRoleSuggestions(roleSearch.value);
    roleSearch.onfocus = () => renderRoleSuggestions(roleSearch.value);
    roleSearch.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addQueryFromInput(roleSearch.value);
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

  // Click-outside to close dropdowns
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

  const data = await storageGet(["userProfile", "trackedCompanies", "trackedJobs", "companyCache"]);
  userProfile = migrateProfile(data.userProfile || null);
  companies = data.trackedCompanies || [];
  trackedJobs = data.trackedJobs || [];
  companyCache = data.companyCache || {};

  updateTrackedTabLabel();

  const hasQueries = Array.isArray(userProfile?.roleQueries) && userProfile.roleQueries.length > 0;
  if (!userProfile || !hasQueries || companies.length === 0) {
    enterSetup(false);
    return;
  }

  // Persist migration if needed
  if (userProfile && !data.userProfile?.roleQueries) {
    await storageSet({ userProfile });
  }

  enterApp();
  await refreshAllCompanies();
  renderCompanies();
})();

// ===============================
// Setup screen
// ===============================
function enterSetup(prefillFromExisting) {
  settingsMode = !!prefillFromExisting;
  if (setupView) setupView.style.display = "block";
  if (appView) appView.style.display = "none";

  setupSelectedQueries =
    prefillFromExisting && userProfile && Array.isArray(userProfile.roleQueries)
      ? [...userProfile.roleQueries]
      : [];

  renderSelectedQueries();
  renderSelectedCompanies();

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

function addQueryFromInput(input) {
  const raw = String(input || "").trim();
  if (!raw) return;

  if (setupSelectedQueries.length >= MAX_QUERIES) {
    showToast(`Max ${MAX_QUERIES} alert keywords`);
    return;
  }

  // Dedup by normalized form
  const n = normalize(raw);
  if (setupSelectedQueries.some((q) => normalize(q) === n)) {
    showToast("Already added");
    return;
  }

  setupSelectedQueries.push(raw);
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
    const row = document.createElement("div");
    row.className = "selected-item";
    row.innerHTML = `
      <div><b>${q}</b></div>
      <button class="btn small">Remove</button>
    `;

    row.querySelector("button").onclick = () => removeQuery(q);
    selectedRolesDiv.appendChild(row);
  });
}

function renderRoleSuggestions(query) {
  if (!roleSuggestions) return;

  const q = String(query || "").trim().toLowerCase();
  roleSuggestions.innerHTML = "";

  if (!q) {
    roleSuggestions.style.display = "none";
    return;
  }

  const matches = ROLE_TEMPLATES
    .filter((t) => t.toLowerCase().includes(q))
    .slice(0, 8);

  // Template matches
  for (const t of matches) {
    const row = document.createElement("div");
    row.className = "suggestion";
    row.textContent = t;
    row.onclick = () => addQueryFromInput(t);
    roleSuggestions.appendChild(row);
  }

  // Allow adding the raw query
  const addRow = document.createElement("div");
  addRow.className = "suggestion";
  addRow.innerHTML = `<div>Add "${String(query).trim()}"</div><div class="smallmuted">Track future posts matching these keywords</div>`;
  addRow.onclick = () => addQueryFromInput(query);
  roleSuggestions.appendChild(addRow);

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

  userProfile = {
    roleQueries: [...setupSelectedQueries],
    createdAt: Date.now(),
  };

  await storageSet({
    userProfile,
    trackedCompanies: companies,
  });

  enterApp();
  await refreshAllCompanies();

  // Post-setup summary (closest matches + newest date)
  const summary = computeMatchSummary();
  if (summary.total > 0) {
    showToast(`Found ${summary.total} matches · newest ${formatDate(summary.newest)}`);
  } else {
    showToast("No matches right now (we’ll catch future posts)");
  }

  renderCompanies();
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
      row.onclick = async () => {
        await addCompany(c);
        companySuggestions.style.display = "none";
        if (companySearch) companySearch.value = "";
      };
      companySuggestions.appendChild(row);
    });

    companySuggestions.style.display = "block";
    return;
  }

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

  if (companies.some((x) => x.boardSlug === slug || x.id === slug)) {
    showToast("Already added");
    return;
  }

  const found = COMPANY_DIRECTORY.find((c) => c.boardSlug === slug);
  if (found) {
    await addCompany(found);
    if (companySearch) companySearch.value = "";
    if (companySuggestions) companySuggestions.style.display = "none";
    return;
  }

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

  await addCompany({
    id: slug,
    name: apiName,
    boardSlug: slug,
    domain: "",
  });

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

async function addCompany(c) {
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

async function persistCompanyEdits() {
  await storageSet({
    trackedCompanies: companies,
    trackedJobs,
    companyCache,
  });
}

async function removeCompany(companyId) {
  companies = companies.filter((c) => c.id !== companyId);

  // keep cache + tracked consistent
  delete companyCache[companyId];
  trackedJobs = trackedJobs.filter((t) => t.companyId !== companyId);

  renderSelectedCompanies();

  // If we're in settings mode (opened from ⚙), persist immediately so UI updates next open
  if (settingsMode) {
    await persistCompanyEdits();
  }
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
  const alerts = (userProfile?.roleQueries || []).join(" · ");
  const comps = companies.map((c) => c.name).join(", ");
  profileStatus.textContent = `Alerts: ${alerts} · Companies: ${comps}`;
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
    card.className = "card";

    const logoUrl = getLogoUrl(c.domain);
    const logoEl = logoUrl ? `<img class="logo" src="${logoUrl}" />` : `<div class="logo"></div>`;

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
      attachLogoFallback(card, c.name);
      companiesList.appendChild(card);
      return;
    }

    const jobs = cache?.jobs || [];
    const matches = getRelevantMatches(jobs, queries);

    if (matches.length === 0) {
      card.innerHTML = `
        <div class="company-header">
          ${logoEl}
          <div style="flex:1;">
            <div class="company-name">${c.name}</div>
            <div class="meta">No matches right now</div>
            <div class="pills"><span class="pill">INACTIVE</span></div>
          </div>
        </div>
      `;
      card.onclick = () => showCompanyJobs(c.id);
      attachLogoFallback(card, c.name);
      companiesList.appendChild(card);
      return;
    }

    const mostRecent = matches[0];
    const posted = formatDate(mostRecent.job.createdAt);

    const pills = [];
    if (isNewJob(mostRecent.job.createdAt)) pills.push(`<span class="pill new">NEW</span>`);
    pills.push(`<span class="pill">${matches.length} roles</span>`);

    card.innerHTML = `
      <div class="company-header">
        ${logoEl}
        <div style="flex:1;">
          <div class="company-name">${c.name}</div>
          <div class="job-title">${mostRecent.job.title}</div>
          <div class="meta">Matched: ${mostRecent.match.query || "—"} · Posted ${posted}</div>
          <div class="pills">${pills.join("")}</div>
        </div>
      </div>
    `;

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

    const alreadyTracked = trackedJobs.some((t) => String(t.jobId) === String(job.id));
    const scorePct = Math.round(match.score * 100);

    row.innerHTML = `
      <div class="jobrow-title">${job.title}</div>
      <div class="jobrow-sub">
        Matched: ${match.query || "—"} · ${scorePct}% · Posted ${formatDate(job.createdAt)}${job.location ? ` · ${job.location}` : ""}
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
        createdAt: job.createdAt,
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
