chrome.runtime.onMessage.addListener((request) => {
  if (request.type === "FETCH_COMPANY_JOBS") {
    const boardSlug = String(request.boardSlug || "").trim().toLowerCase();
    if (!boardSlug) return Promise.resolve({ error: "Missing boardSlug" });

    const url = `https://boards.greenhouse.io/v1/boards/${encodeURIComponent(boardSlug)}/jobs`;

    return fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`Greenhouse HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        const companyName =
          data.company?.name ||
          request.companyName ||
          boardSlug;

        const jobs = (data.jobs || []).map((job) => ({
          id: job.id,                          // important for tracking
          title: job.title,
          link: job.absolute_url,
          createdAt: job.created_at,
          updatedAt: job.updated_at || null,
          location: job.location?.name || "",
          company: companyName,
          companyId: boardSlug
        }));

        return { company: { id: boardSlug, name: companyName }, jobs };
      })
      .catch((err) => {
        return { error: err.toString() };
      });
  }
});
