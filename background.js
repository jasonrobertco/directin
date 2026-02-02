// background.js
// -----------------------------------------------------------------------------
// MV3 Service Worker
// - Fetch Greenhouse jobs by boardSlug
// - On extension icon click, tell content.js to reopen the UI (minimized)
// -----------------------------------------------------------------------------

console.log("[DirectIn] background service worker loaded");

// Toolbar click => reopen UI (minimized) on active LinkedIn tab
chrome.action.onClicked.addListener(async () => {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs?.[0];
    if (!tab?.id) return;

    // Only try to open on LinkedIn pages (avoid errors elsewhere)
    const url = String(tab.url || "");
    if (!url.includes("linkedin.com")) return;

    chrome.tabs.sendMessage(tab.id, { type: "DIRECTIN_OPEN" });
  } catch (err) {
    console.warn("[DirectIn] onClicked error:", err);
  }
});

// Messages from overlay.js (via chrome.runtime.sendMessage)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  try {
    // Legacy support
    if (request?.type === "FETCH_STRIPE_JOBS") {
      fetchGreenhouseJobs("stripe", "Stripe", sendResponse);
      return true;
    }

    // Primary path
    if (request?.type === "FETCH_COMPANY_JOBS") {
      const slug = String(request.boardSlug || "").trim().toLowerCase();
      const fallbackName = String(request.companyName || "").trim();

      if (!slug) {
        sendResponse({ error: "Missing boardSlug" });
        return false;
      }

      fetchGreenhouseJobs(slug, fallbackName, sendResponse);
      return true;
    }

    return false;
  } catch (err) {
    sendResponse({ error: String(err) });
    return false;
  }
});

function fetchGreenhouseJobs(boardSlug, fallbackCompanyName, sendResponse) {
  const url = `https://boards.greenhouse.io/v1/boards/${encodeURIComponent(boardSlug)}/jobs`;

  fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((data) => {
      const companyName = data?.company?.name || fallbackCompanyName || boardSlug;

      const jobs = (data?.jobs || []).map((job) => ({
        id: job.id,
        title: job.title,
        link: job.absolute_url,
        createdAt: job.created_at,
        location: job.location?.name || ""
      }));

      sendResponse({
        company: { name: companyName, slug: boardSlug },
        jobs
      });
    })
    .catch((err) => {
      sendResponse({ error: String(err) });
    });
}
