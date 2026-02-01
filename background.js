chrome.runtime.onMessage.addListener((request, sender) => {
  if (request.type === "FETCH_STRIPE_JOBS") {
    return fetch("https://boards.greenhouse.io/v1/boards/stripe/jobs")
      .then(res => res.json())
      .then(data => {
        const jobs = data.jobs.map(job => ({
          title: job.title,
          link: job.absolute_url,
          createdAt: job.created_at,
          company: data.company?.name || "Stripe",
          companyDomain: "stripe.com"
        }));

        return { jobs }; // ✅ resolved value becomes response
      })
      .catch(err => {
        return { error: err.toString() }; // ✅ safe
      });
  }
});
