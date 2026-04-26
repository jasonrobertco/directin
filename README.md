# DirectIn

DirectIn is a Manifest V3 Chrome extension that injects a job-tracking overlay into LinkedIn pages. Users can configure up to 10 companies and up to 3 free-text alert keywords, fetch openings from supported job boards, surface matched roles inside the overlay, and track up to 5 individual jobs for status changes using `chrome.storage.local`.

## Repository Structure

```text
.
├── DESIGN_SYSTEM.md
├── background.js
├── company_directory.js
├── content.js
├── directinlogo.png
├── directinlogo.svg
├── manifest.json
├── overlay.css
├── overlay.html
└── overlay.js
```

## Key Features

- Injects a floating dock and iframe-based overlay on `https://www.linkedin.com/*`.
- Stores a user profile with alert keywords and tracked companies in `chrome.storage.local`.
- Fetches job listings from Greenhouse boards through the MV3 service worker.
- Includes a Lever fetcher in the background worker, although provider wiring in the overlay is not fully integrated.
- Scores job titles against free-text alert keywords using token matching, abbreviation expansion, and a seniority blocklist.
- Caches fetched company jobs locally and computes badge counts from matching roles.
- Lets users track up to 5 specific jobs and marks them as `open`, `changed`, or `closed` on refresh.
- Falls back to link-only company cards for unsupported custom careers pages.

## Tech Stack

| Area | Implementation |
| --- | --- |
| Runtime | Chrome Extension, Manifest V3 |
| Language | Vanilla JavaScript |
| UI | HTML + CSS inside an iframe overlay |
| Persistence | `chrome.storage.local` |
| Data sources | Greenhouse API, Lever JSON endpoint |
| Assets | PNG and SVG extension icons |

## Architecture Notes

- `manifest.json` registers `background.js` as the service worker, injects `content.js` on LinkedIn pages, and exposes the overlay assets as web-accessible resources.
- `content.js` owns page-level UI injection, dock behavior, minimized/restored state, badge rendering, and postMessage communication with the iframe overlay.
- `overlay.html`, `overlay.css`, and `overlay.js` implement the setup flow, company list, matched-role detail view, tracked-job list, and refresh logic.
- `background.js` handles cross-origin job fetches and responds to `FETCH_COMPANY_JOBS` messages from the overlay.
- `company_directory.js` provides a curated starter company list with provider metadata, board slugs, domains, and careers URLs.
- The extension persists three primary local-storage records:

| Key | Shape | Purpose |
| --- | --- | --- |
| `userProfile` | `{ roleQueries, companies, createdAt }` | Saved setup state |
| `companyCache` | `{ [companyId]: { fetchedAt, error, jobs, companyName } }` | Cached fetch results |
| `trackedJobs` | `[{ jobId, companyId, status, ... }]` | User-tracked jobs |

## Getting Started

This repository does not include a package manager manifest, build pipeline, or bundler configuration. The extension is intended to be loaded directly as an unpacked Chrome extension.

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable Developer Mode.
3. Choose **Load unpacked**.
4. Select the repository root: `/Users/jasonco/Documents/directin`.
5. Open LinkedIn in Chrome to allow the content script to inject the DirectIn dock.

## Available Scripts or Commands

No project scripts, package commands, Make targets, or checked-in CLI workflows are defined in this repository.

## Environment Variables

No `.env`, `.env.example`, or environment-variable-based configuration is present in the repository.

## Testing

No automated test suite, test runner configuration, or test scripts are present in the repository.

## Build / Deployment Notes

- There is no build step; the checked-in files are the runtime artifacts used by the extension.
- `manifest.json` currently requests `storage` and `tabs` permissions plus host access for:
  - `https://boards.greenhouse.io/*`
  - `https://api.lever.co/*`
  - `https://jobs.lever.co/*`
- The current implementation is designed for local unpacked loading rather than a documented Chrome Web Store release flow.

## Future Improvements

The repository contains partial multi-provider support that is not fully wired end-to-end in the current UI flow. In particular:

- `background.js` implements both Greenhouse and Lever fetch paths.
- `company_directory.js` includes curated `lever` and `custom` entries.
- `overlay.js` currently refreshes companies through a Greenhouse-default path and treats unsupported providers as link-only cards.

Those gaps are visible in the codebase today, so they are the clearest next area for product hardening before a broader public release.
