# LAFing Cow FT Dashboard

A lightweight web dashboard for monitoring Playwright functional test (FT) health for the **LAFing Cow** (How, When, Where) team. Provides real-time visibility into test runs, allow list status, cross-PR failure spikes, and one-click test dispatching -- all powered by the GitHub API.

## Features

- **Main Branch FT Runs** -- View the last 10 runs of the `03-Util` scheduled workflow that runs FTs against `main` every 2 hours
- **LAFing Cow Dispatch Runs** -- Track team-specific dispatch runs filtered from the `01-PRCI` workflow
- **Allow List Status** -- Check which owned tests are on the FT allow list (Project #266) vs. quarantined on the disallow list (Project #277) via GitHub Projects GraphQL
- **Cross-PR Spike Detection** -- Surface systemic failures by detecting when FT failures span 3+ branches in 24 hours
- **Dispatch FTs** -- Trigger LAFing Cow FT runs or run specific tests by grep string directly from the dashboard
- **Daily Email Alerts** -- Automated GitHub Actions workflow collects data daily and emails a summary with spike/failure alerts

## Owned Test Files

| Test File | Package |
|---|---|
| `StoreDetails.func.ts` | `@kroger/store/kroger-store-details` |
| `StoreRoutes.func.ts` | `@kroger/store/kroger-store-tests` |
| `ModalitySelectorV2.func.ts` | `@kroger/core/modality-selector-ui` |
| `ModalitySelector-authenticatedV2.func.ts` | `@kroger/core/modality-selector-ui` |
| `ModalitySelectorV2-auth-delivery.func.ts` | `@kroger/core/modality-selector-ui` |

## Getting Started

### Prerequisites

A GitHub Personal Access Token (PAT) with these scopes:
- `repo` -- access workflow runs
- `workflow` -- dispatch workflow runs
- `read:project` -- read GitHub Projects (allow list / disallow list)

### Run Locally

```bash
# Any static file server works
npx serve .
# or
python3 -m http.server 8080
```

Open `http://localhost:8080`, enter your GitHub PAT, and the dashboard loads.

No build step, no dependencies -- just static HTML, JS, and Tailwind via CDN.

## Project Structure

```
ft-dashboard/
  index.html              # Dashboard UI (Tailwind CSS)
  js/
    api.js                # GitHub REST/GraphQL API wrapper (auth, workflow runs, allow list, dispatch)
    dashboard.js          # UI rendering, event handlers, auto-refresh (5 min)
  data/
    daily-YYYY-MM-DD.json # Collected FT data snapshots (committed by CI)
    latest.json           # Copy of the most recent daily snapshot
  .github/workflows/
    collect-ft-data.yml   # Scheduled (weekdays 8:53 AM EST): collects FT data, commits to data/, sends email alerts
    dispatch-lafingcow.yml # Scheduled (weekdays 9:07 AM EST): dispatches lafingcow FTs against main
```

## GitHub Actions

### `collect-ft-data.yml` -- Daily Data Collection

Runs weekdays at **8:53 AM EST**. Collects main branch FT run results, LAFing Cow dispatch results, and cross-PR spike data from the [esperanto](https://github.com/krogertechnology/esperanto) repo. Commits a JSON snapshot to `data/` and sends an email summary to the team. Alerts escalate if:
- A cross-PR spike is detected (failures across 3+ branches in 24h)
- The latest main branch FT run failed

### `dispatch-lafingcow.yml` -- Daily FT Dispatch

Runs weekdays at **9:07 AM EST**. Dispatches the `01-PRCI-dispatchFunctionalTests.yml` workflow in esperanto with the `lafingcow` team config against `main`. Can also be triggered manually with a custom branch/ref.

Both workflows require the `ESPERANTO_PAT` repository secret.

## Tech Stack

- **Frontend**: Vanilla HTML/JS, [Tailwind CSS](https://tailwindcss.com) (CDN)
- **API**: GitHub REST API v3 + GraphQL API v4 (via `fetch`, no Octokit)
- **Auth**: GitHub PAT stored in `localStorage`
- **CI**: GitHub Actions (scheduled workflows)
- **Data**: JSON snapshots committed to the repo

## Configuration

Key constants in `js/api.js`:

| Constant | Value | Description |
|---|---|---|
| `OWNER` | `krogertechnology` | GitHub organization |
| `REPO` | `esperanto` | Target repository |
| `ALLOW_LIST_PROJECT` | `266` | FT allow list GitHub Project number |
| `DISALLOW_LIST_PROJECT` | `277` | FT disallow/quarantine list Project number |
| `WORKFLOWS` | (object) | Workflow IDs and filenames for esperanto FT pipelines |
