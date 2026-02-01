const setupDiv = document.getElementById("setup");
const mainDiv = document.getElementById("main");
const jobsList = document.getElementById("jobs");
const profileStatus = document.getElementById("profileStatus");

console.log("Overlay loaded");

// ---------- PROFILE BOOTSTRAP ----------
chrome.storage.local.get(["userProfile"], data => {
  if (!data.userProfile) {
    showSetup();
  } else {
    showMain(data.userProfile);
  }
});

// ---------- RELEVANCE LOGIC ----------
function isRelevantJob(job, profile) {
  const title = job.title.toLowerCase();

  // Must be SWE / IC
  if (
    !title.includes("software") &&
    !title.includes("engineer")
  ) return false;

  // Exclude management
  if (
    title.includes("manager") ||
    title.includes("head")
  ) return false;

  // Exclude senior+ IC
  if (
    title.includes("senior") ||
    title.includes("staff") ||
    title.includes("principal") ||
    title.includes("lead")
  ) return false;

  return true;
}

// ---------- HELPERS ----------
function renderProfile(profile) {
  profileStatus.textContent =
    `Tracking: ${profile.role} · ${profile.location} · ${profile.companies.join(", ")}`;
}

function getMostRecentRelevantJob(jobs, profile) {
  const relevant = jobs.filter(job => isRelevantJob(job, profile));

  if (relevant.length === 0) return null;

  return relevant.sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  )[0];
}

// ---------- SETUP ----------
function showSetup() {
  setupDiv.style.display = "block";
  mainDiv.style.display = "none";
  profileStatus.textContent = "";

  document.getElementById("saveProfile").onclick = () => {
    const profile = {
      role: document.getElementById("role").value,
      location: document.getElementById("location").value,
      companies: ["Netflix"], // still hardcoded
      createdAt: Date.now()
    };

    chrome.storage.local.set({ userProfile: profile }, () => {
      showMain(profile);
    });
  };
}

// ---------- MAIN ----------
function showMain(profile) {
  setupDiv.style.display = "none";
  mainDiv.style.display = "block";
  renderProfile(profile);

  jobsList.innerHTML = "<p class='muted'>Checking Stripe…</p>";

  chrome.runtime.sendMessage({ type: "FETCH_STRIPE_JOBS" }, response => {
    if (!response || response.error) {
      jobsList.innerHTML = "<p>Error loading jobs</p>";
      return;
    }

    console.log("ALL JOBS:", response.jobs);

    const job = getMostRecentRelevantJob(response.jobs, profile);
    console.log("SELECTED JOB:", job);

    jobsList.innerHTML = "";

    if (!job) {
      jobsList.innerHTML =
        "<p class='muted'>No relevant roles right now.</p>";
      return;
    }

    renderCompanyCard(job);
  });
}

// ---------- UI ----------
function renderCompanyCard(job) {
  const logoUrl = getCompanyLogo(job.companyDomain);

  const postedText = job.createdAt
    ? new Date(job.createdAt).toLocaleDateString()
    : "—";

  const card = document.createElement("div");
  card.className = "company-card";

  card.innerHTML = `
    <div class="company-header">
      <img src="${logoUrl}" class="company-logo" />
      <div>
        <div class="company-name">${job.company}</div>
        <div class="job-title">${job.title}</div>
        <div class="job-date">Posted ${postedText}</div>
      </div>
    </div>
  `;

  jobsList.appendChild(card);
}

// ---------- LOGO ----------
function getCompanyLogo(domain) {
  if (!domain) return "";
  return `https://logo.clearbit.com/${domain}`;
}
