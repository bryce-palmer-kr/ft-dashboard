/**
 * Dashboard UI logic
 * Renders cards, handles dispatch buttons, refreshes data
 */

// ── State ──
let isLoading = false;
let lastRefresh = null;
let summaryIssues = [];
let allowListData = null;
let prciFailedRuns = [];
let testHistoryData = null;
let countdownInterval = null;
let refreshSecondsLeft = 0;
const REFRESH_INTERVAL_S = 5 * 60;
const GITHUB_BASE = 'https://github.com/krogertechnology/esperanto';
const ALLOW_LIST_URL = 'https://github.com/orgs/krogertechnology/projects/266';
const DEFAULT_ROWS = 5;

// ── Fix Suggestion Rules ──

const FIX_RULES = [
  {
    pattern: /timeout.*exceeded|waiting.*\d+ms|timed out|navigation timeout/i,
    label: 'Timeout',
    suggestion: 'Increase the test timeout or add an explicit wait for a stable condition.',
    snippet: 'test.setTimeout(60_000);',
  },
  {
    pattern: /locator.*resolved to|element.*not found|strict mode violation|getByTestId/i,
    label: 'Selector changed',
    suggestion: 'A data-testid or element selector may have changed in a recent PR.',
    snippet: "// Verify: page.getByTestId('your-testid')",
  },
  {
    pattern: /network|fetch failed|api.*error|status (500|503|502)|connection refused/i,
    label: 'Missing mock',
    suggestion: 'This API route may not be mocked. Add or update bulkMockEndpoints.',
    snippet: "// In test setup:\nawait bulkMockEndpoints(page, [\n  { url: '/api/your-route', fixture: 'your-fixture.json' },\n]);",
  },
  {
    pattern: /msal|redirect.*login|auth.*redirect|loginRedirect/i,
    label: 'Auth redirect',
    suggestion: 'MSAL is redirecting to login. Start the server with NODE_CONFIG_ENV=local-pipeline.',
    snippet: 'NODE_CONFIG_ENV=local-pipeline yarn start',
  },
  {
    pattern: /expected.*received|toEqual|toBe\(|assertion.*failed/i,
    label: 'Assertion mismatch',
    suggestion: 'The component output changed. Re-check the expected value or add a waitFor.',
    snippet: "// Add before assertion:\nawait expect(page.getByTestId('element')).toBeVisible();",
  },
];

function getSuggestedFix(failureMessage) {
  if (!failureMessage) return null;
  return FIX_RULES.find((r) => r.pattern.test(failureMessage)) || null;
}

function copySnippet(snippetId) {
  const el = document.getElementById(snippetId);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).then(() => showToast('Snippet copied', 'info'));
}
window.copySnippet = copySnippet;

// ── DOM Helpers ──

function $(selector) {
  return document.querySelector(selector);
}

function show(el) {
  if (typeof el === 'string') el = $(el);
  el?.classList.remove('hidden');
}

function hide(el) {
  if (typeof el === 'string') el = $(el);
  el?.classList.add('hidden');
}

function setHTML(selector, html) {
  const el = $(selector);
  if (el) el.innerHTML = html;
}

function setText(selector, text) {
  const el = $(selector);
  if (el) el.textContent = text;
}

// ── Time formatting ──

function timeAgo(dateStr) {
  const now = new Date();
  const then = new Date(dateStr);
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return then.toLocaleDateString();
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function timeCell(dateStr) {
  return `<span title="${formatDate(dateStr)}">${timeAgo(dateStr)}</span>`;
}

// ── Status badges ──

function statusBadge(conclusion) {
  const map = {
    success: { bg: 'bg-green-100', text: 'text-green-800', label: 'PASS' },
    failure: { bg: 'bg-red-100', text: 'text-red-800', label: 'FAIL' },
    cancelled: { bg: 'bg-gray-100', text: 'text-gray-800', label: 'CANCELLED' },
    skipped: { bg: 'bg-gray-100', text: 'text-gray-600', label: 'SKIPPED' },
    in_progress: { bg: 'bg-yellow-100', text: 'text-yellow-800', label: 'RUNNING' },
    queued: { bg: 'bg-blue-100', text: 'text-blue-800', label: 'QUEUED' },
    null: { bg: 'bg-yellow-100', text: 'text-yellow-800', label: 'RUNNING' },
  };
  const s = map[conclusion] || map.null;
  return `<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${s.bg} ${s.text}">${s.label}</span>`;
}

function branchLink(branch) {
  if (branch === 'main') return `<span class="text-gray-500">${branch}</span>`;
  return `<a href="${GITHUB_BASE}/tree/${encodeURIComponent(branch)}" target="_blank" class="text-gray-500 hover:text-blue-600 hover:underline">${branch}</a>`;
}

// ── Failure Detail Expansion ──

const failureDetailsCache = new Map();

function renderFailureDetails(details) {
  if (details.failures.length === 0) {
    return `
      <div class="px-4 py-3 text-sm text-gray-500 italic">
        No test failure annotations found (${details.totalFailedJobs} failed job${details.totalFailedJobs !== 1 ? 's' : ''}).
        This may be an infrastructure failure &mdash; check the run logs directly.
      </div>
    `;
  }

  const items = details.failures.map((f) => {
    const fix = getSuggestedFix(f.message);
    const snippetId = fix ? `snip-${Math.random().toString(36).slice(2, 8)}` : null;
    return `
      <div class="py-2 border-b border-red-100 last:border-0">
        <div class="flex items-start gap-2">
          <span class="text-red-500 mt-0.5 shrink-0">&#10007;</span>
          <div class="min-w-0 w-full">
            <div class="font-medium text-sm text-gray-800 truncate" title="${f.testPath}">${f.testFile}</div>
            <div class="text-xs text-gray-400 truncate" title="${f.testPath}">${f.testPath}</div>
            ${f.message ? `
              <details class="mt-1">
                <summary class="text-xs text-gray-500 cursor-pointer hover:text-gray-700">Show error</summary>
                <pre class="mt-1 text-xs text-red-700 bg-red-50 rounded p-2 whitespace-pre-wrap max-h-32 overflow-y-auto">${escapeHtml(f.message)}</pre>
              </details>
            ` : ''}
            ${fix ? `
              <div class="mt-1.5 p-2 bg-blue-50 border border-blue-100 rounded text-xs">
                <div class="flex items-center justify-between gap-2 mb-1">
                  <span class="font-medium text-blue-700">&#128161; Suggested fix: ${fix.label}</span>
                  <button onclick="copySnippet('${snippetId}')" class="text-blue-500 hover:text-blue-700 text-xs shrink-0">Copy snippet</button>
                </div>
                <p class="text-blue-600 mb-1">${fix.suggestion}</p>
                <code id="${snippetId}" class="block bg-white border border-blue-200 rounded px-2 py-1 text-blue-800 font-mono text-xs whitespace-pre-wrap">${escapeHtml(fix.snippet)}</code>
              </div>
            ` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Deduplicate test file names for re-run grep string
  const uniqueFiles = [...new Set(details.failures.map((f) => f.testFile.replace(/\.func\.ts$/, '')))];
  const grepString = uniqueFiles.join('|');
  const escapedGrep = escapeHtml(grepString);

  return `
    <div class="px-4 py-2">
      <div class="flex items-center justify-between mb-2">
        <div class="text-xs text-gray-500">${details.failures.length} failing test${details.failures.length !== 1 ? 's' : ''} across ${details.totalFailedJobs} failed job${details.totalFailedJobs !== 1 ? 's' : ''}</div>
        <button onclick="rerunFailures('${escapedGrep}', '${details.branch || 'main'}')" class="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors">
          &#9654; Re-run failures
        </button>
      </div>
      <div class="max-h-64 overflow-y-auto">${items}</div>
    </div>
  `;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function toggleFailureDetails(runId, detailRowId, colspan, ownedOnly, branch) {
  const detailRow = document.getElementById(detailRowId);
  if (!detailRow) return;
  const parentRow = detailRow.previousElementSibling;
  const chevron = parentRow?.querySelector('[data-chevron]');
  const td = detailRow.querySelector('td');

  // Toggle off
  if (!detailRow.classList.contains('hidden')) {
    detailRow.classList.add('hidden');
    parentRow?.classList.remove('bg-red-50');
    if (chevron) chevron.innerHTML = '&#9660;';
    return;
  }

  // Toggle on
  detailRow.classList.remove('hidden');
  parentRow?.classList.add('bg-red-50');
  if (chevron) chevron.innerHTML = '&#9650;';

  // Use cache if available
  if (failureDetailsCache.has(runId)) {
    td.innerHTML = renderFailureDetails(failureDetailsCache.get(runId));
    return;
  }

  // Lazy-load
  td.innerHTML = '<div class="px-4 py-3 text-sm text-gray-400">Loading failure details...</div>';
  try {
    const details = await FTApi.getRunFailureDetails(runId, { ownedOnly });
    details.branch = branch || 'main';
    failureDetailsCache.set(runId, details);
    td.innerHTML = renderFailureDetails(details);
  } catch (err) {
    td.innerHTML = `<div class="px-4 py-3 text-sm text-red-500">Failed to load details: ${err.message}</div>`;
  }
}
window.toggleFailureDetails = toggleFailureDetails;

async function rerunFailures(grepString, branch) {
  const confirmed = await confirmDispatch(
    `Re-run "${grepString}" on "${branch}" with 5 repeats? This triggers a CI run (~20 min) using shared resources.`
  );
  if (!confirmed) return;

  try {
    const result = await FTApi.dispatchByString(grepString, branch);
    showToast(result.message, 'success');

    // Inject a synthetic "QUEUED" row at the top of the LAFing Cow table
    const tbody = document.getElementById('lafingcow-runs-body');
    if (tbody) {
      const syntheticRow = document.createElement('tr');
      syntheticRow.className = 'hover:bg-gray-50 border-t border-gray-50';
      syntheticRow.setAttribute('data-synthetic', 'true');
      syntheticRow.innerHTML = `
        <td class="px-4 py-2 text-sm">${statusBadge('queued')}</td>
        <td class="px-4 py-2 text-sm text-gray-600">just now</td>
        <td class="px-4 py-2 text-sm">${branchLink(branch)}</td>
        <td class="px-4 py-2 text-sm text-gray-500 truncate max-w-xs" title="${escapeHtml(grepString)}">${escapeHtml(grepString)}</td>
        <td class="px-4 py-2 text-sm text-gray-400 italic">pending</td>
      `;
      tbody.insertBefore(syntheticRow, tbody.firstChild);
    }

    // Refresh after 15s to pick up the real run from the API
    setTimeout(() => refreshLafingcowRuns(), 15000);
  } catch (err) {
    showToast(`Dispatch failed: ${err.message}`, 'error');
  }
}
window.rerunFailures = rerunFailures;

async function dispatchRestore(testTitle) {
  const label = testTitle.includes('|')
    ? `${testTitle.split('|').length} LAFing Cow tests from disallow list`
    : `"${testTitle}"`;

  const confirmed = await confirmDispatch(
    `Trigger restore workflow for ${label}? Tests will be validated (1 run) then gauntleted (10 repeats). Passing tests are moved to the allow list.`
  );
  if (!confirmed) return;

  try {
    const result = await FTApi.dispatchRestoreWorkflow(testTitle);
    showToast(result.message, 'success');
  } catch (err) {
    showToast(`Restore dispatch failed: ${err.message}`, 'error');
  }
}
window.dispatchRestore = dispatchRestore;

// ── Confirm Modal ──

let confirmResolve = null;

function confirmDispatch(message) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    setText('#confirm-message', message);
    show('#confirm-modal');
  });
}

function setupConfirmModal() {
  $('#confirm-ok-btn')?.addEventListener('click', () => {
    hide('#confirm-modal');
    confirmResolve?.(true);
    confirmResolve = null;
  });
  $('#confirm-cancel-btn')?.addEventListener('click', () => {
    hide('#confirm-modal');
    confirmResolve?.(false);
    confirmResolve = null;
  });
}

// ── Help Modal ──

function setupHelpModal() {
  $('#help-btn')?.addEventListener('click', () => show('#help-modal'));
  $('#help-close-btn')?.addEventListener('click', () => hide('#help-modal'));
  $('#help-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) hide('#help-modal');
  });
}

// ── Keyboard Shortcuts ──

function setupKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'r' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      refreshAll();
    }
    if (e.key === 'Escape') {
      hide('#help-modal');
      hide('#confirm-modal');
      confirmResolve?.(false);
      confirmResolve = null;
    }
  });
}

// ── Auth ──

function setupAuth() {
  const authSection = $('#auth-section');
  const dashboardSection = $('#dashboard-section');
  const tokenInput = $('#token-input');
  const authBtn = $('#auth-btn');
  const authError = $('#auth-error');

  if (FTApi.isAuthenticated()) {
    hide(authSection);
    show(dashboardSection);
    initDashboard();
    return;
  }

  show(authSection);
  hide(dashboardSection);

  authBtn.addEventListener('click', async () => {
    const token = tokenInput.value.trim();
    if (!token) {
      show(authError);
      setText('#auth-error', 'Please enter a token');
      return;
    }

    authBtn.disabled = true;
    authBtn.textContent = 'Verifying...';

    try {
      FTApi.setToken(token);
      const user = await FTApi.verifyToken();
      setText('#user-name', user.login);

      hide(authSection);
      show(dashboardSection);
      initDashboard();
    } catch (err) {
      FTApi.clearToken();
      show(authError);
      setText('#auth-error', `Auth failed: ${err.message}`);
      authBtn.disabled = false;
      authBtn.textContent = 'Connect';
    }
  });

  tokenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') authBtn.click();
  });
}

function setupLogout() {
  $('#logout-btn')?.addEventListener('click', () => {
    FTApi.clearToken();
    location.reload();
  });
}

// ── Dashboard Init ──

async function initDashboard() {
  try {
    const user = await FTApi.verifyToken();
    setText('#user-name', user.login);
  } catch {
    FTApi.clearToken();
    location.reload();
    return;
  }

  setupLogout();
  setupDispatchButtons();
  setupHelpModal();
  setupConfirmModal();
  setupKeyboard();
  refreshAll();
  startCountdown();
}

// ── Countdown Timer ──

function startCountdown() {
  refreshSecondsLeft = REFRESH_INTERVAL_S;
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    if (!FTApi.isAuthenticated()) return;
    refreshSecondsLeft--;
    if (refreshSecondsLeft <= 0) {
      if (document.visibilityState === 'visible') {
        refreshAll();
      }
      refreshSecondsLeft = REFRESH_INTERVAL_S;
    }
    updateRefreshStatus();
  }, 1000);
}

function updateRefreshStatus() {
  const min = Math.floor(refreshSecondsLeft / 60);
  const sec = String(refreshSecondsLeft % 60).padStart(2, '0');
  const lastPart = lastRefresh ? ` · Updated ${formatDate(lastRefresh.toISOString())}` : '';
  setText('#refresh-status', `${min}:${sec}${lastPart}`);
}

// ── Summary Bar ──

function renderSummaryBar() {
  const el = $('#summary-content');
  if (!el) return;

  if (summaryIssues.length === 0) {
    el.className = 'rounded-lg px-4 py-3 text-sm flex items-center gap-2 bg-green-50 border border-green-200 text-green-800';
    el.innerHTML = '<span class="text-lg">&#10003;</span> All systems green — no issues detected';
  } else {
    el.className = 'rounded-lg px-4 py-3 text-sm bg-red-50 border border-red-200 text-red-800';
    el.innerHTML = `
      <div class="flex items-center gap-2 font-semibold mb-1">
        <span class="text-lg">&#9888;</span>
        ${summaryIssues.length} issue${summaryIssues.length > 1 ? 's' : ''} need${summaryIssues.length === 1 ? 's' : ''} attention
      </div>
      <ul class="list-disc list-inside text-xs space-y-0.5 text-red-700">
        ${summaryIssues.map((i) => `<li>${i}</li>`).join('')}
      </ul>
    `;
  }
}

// ── Data Refresh ──

async function refreshAll() {
  if (isLoading) return;
  isLoading = true;
  summaryIssues = [];
  failureDetailsCache.clear();
  setText('#refresh-status', 'Refreshing...');

  try {
    await Promise.allSettled([
      refreshMainRuns(),
      refreshLafingcowRuns(),
      refreshAllowList(),
      refreshPRCIRuns(),
    ]);

    renderOwnedTests();
    renderSummaryBar();

    lastRefresh = new Date();
    refreshSecondsLeft = REFRESH_INTERVAL_S;
    updateRefreshStatus();
  } catch (err) {
    setText('#refresh-status', `Error: ${err.message}`);
  } finally {
    isLoading = false;
  }
}

// ── Main Branch Runs ──

async function refreshMainRuns() {
  setHTML('#main-runs-body', skeletonRows(4, 3));
  try {
    const runs = await FTApi.getWorkflowRuns('mainFailures', { limit: 10 });
    if (runs.length === 0) {
      setHTML('#main-runs-body', emptyRow(4, 'No runs found'));
      return;
    }

    // For each failed run, check if OUR tests failed (not other teams')
    const failedRuns = runs.filter((r) => r.conclusion === 'failure');
    const ownedFailureChecks = await Promise.all(
      failedRuns.map((r) => FTApi.checkRunForOwnedFailures(r.id))
    );
    const ownedFailureMap = new Map();
    failedRuns.forEach((r, i) => ownedFailureMap.set(r.id, ownedFailureChecks[i]));

    // Override conclusion: if the run failed but NOT our tests, show as pass
    const enrichedRuns = runs.map((r) => {
      if (r.conclusion === 'failure' && !ownedFailureMap.get(r.id)) {
        return { ...r, ownedConclusion: 'success', otherTeamFailure: true };
      }
      return { ...r, ownedConclusion: r.conclusion, otherTeamFailure: false };
    });

    const passCount = enrichedRuns.filter((r) => r.ownedConclusion === 'success').length;
    const failCount = enrichedRuns.filter((r) => r.ownedConclusion === 'failure').length;
    setText('#main-pass-count', passCount);
    setText('#main-fail-count', failCount);

    if (failCount > 0) {
      summaryIssues.push(`Main branch: owned tests failed in ${failCount} of last ${runs.length} runs`);
    }

    renderTable('#main-runs-body', enrichedRuns, (r) => {
      const isFail = r.ownedConclusion === 'failure';
      const detailId = `detail-main-${r.id}`;
      const clickAttr = isFail ? `cursor-pointer` : '';
      const onClickAttr = isFail ? `onclick="toggleFailureDetails(${r.id}, '${detailId}', 4, true, '${r.branch}')"` : '';
      const chevron = isFail ? '<span data-chevron class="text-gray-400 text-xs ml-1">&#9660;</span>' : '';

      return `
        <tr class="hover:bg-gray-50 border-t border-gray-50 ${clickAttr}" ${onClickAttr}>
          <td class="px-4 py-2 text-sm">
            ${statusBadge(r.ownedConclusion || r.status)}
            ${r.otherTeamFailure ? '<span class="text-xs text-gray-400 ml-1" title="Run failed but not our tests">(other team)</span>' : ''}
            ${chevron}
          </td>
          <td class="px-4 py-2 text-sm text-gray-600">${timeCell(r.createdAt)}</td>
          <td class="px-4 py-2 text-sm">${branchLink(r.branch)}</td>
          <td class="px-4 py-2 text-sm" onclick="event.stopPropagation()">
            <a href="${r.url}" target="_blank" class="text-blue-600 hover:underline">View</a>${copyLinkBtn(r.url)}
          </td>
        </tr>
        ${isFail ? `<tr id="${detailId}" class="hidden"><td colspan="4" class="bg-red-50/50 border-t-0"></td></tr>` : ''}
      `;
    }, 4);
  } catch (err) {
    setHTML('#main-runs-body', errorRow(4, err.message));
  }
}

// ── LAFing Cow Dispatch Runs ──

async function refreshLafingcowRuns() {
  setHTML('#lafingcow-runs-body', skeletonRows(5, 3));
  try {
    const runs = await FTApi.getLafingcowRuns(10);
    if (runs.length === 0) {
      setHTML('#lafingcow-runs-body', emptyRow(5, 'No lafingcow runs found'));
      return;
    }

    renderTable('#lafingcow-runs-body', runs, (r) => {
      const isFail = r.conclusion === 'failure';
      const detailId = `detail-lc-${r.id}`;
      const clickAttr = isFail ? `cursor-pointer` : '';
      const onClickAttr = isFail ? `onclick="toggleFailureDetails(${r.id}, '${detailId}', 5, false, '${r.branch}')"` : '';
      const chevron = isFail ? '<span data-chevron class="text-gray-400 text-xs ml-1">&#9660;</span>' : '';

      return `
        <tr class="hover:bg-gray-50 border-t border-gray-50 ${clickAttr}" ${onClickAttr}>
          <td class="px-4 py-2 text-sm">
            ${statusBadge(r.conclusion || r.status)}
            ${chevron}
          </td>
          <td class="px-4 py-2 text-sm text-gray-600">${timeCell(r.createdAt)}</td>
          <td class="px-4 py-2 text-sm">${branchLink(r.branch)}</td>
          <td class="px-4 py-2 text-sm text-gray-500 truncate max-w-xs">${r.name}</td>
          <td class="px-4 py-2 text-sm" onclick="event.stopPropagation()">
            <a href="${r.url}" target="_blank" class="text-blue-600 hover:underline">View</a>${copyLinkBtn(r.url)}
          </td>
        </tr>
        ${isFail ? `<tr id="${detailId}" class="hidden"><td colspan="5" class="bg-red-50/50 border-t-0"></td></tr>` : ''}
      `;
    }, 5);
  } catch (err) {
    setHTML('#lafingcow-runs-body', errorRow(5, err.message));
  }
}

// ── Test History ──

function transitionBadge(state) {
  const map = {
    allowList: { cls: 'bg-green-100 text-green-800', label: 'Allow List' },
    quarantine: { cls: 'bg-yellow-100 text-yellow-800', label: 'Quarantine' },
    unknown: { cls: 'bg-gray-100 text-gray-600', label: 'Unknown' },
  };
  const s = map[state] || map.unknown;
  return `<span class="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${s.cls}">${s.label}</span>`;
}

function renderTestHistoryPanel(history) {
  if (!history || history.transitions.length === 0) {
    return `
      <div class="text-xs text-gray-400 text-center py-3 italic">
        No transitions recorded yet. History builds daily as CI collects snapshots.
      </div>
    `;
  }

  // Group by test name (most recent transitions first overall)
  const byTest = new Map();
  for (const tr of [...history.transitions].reverse()) {
    const key = tr.test;
    if (!byTest.has(key)) byTest.set(key, []);
    byTest.get(key).push(tr);
  }

  return `
    <div class="space-y-2 max-h-80 overflow-y-auto">
      ${[...byTest.entries()].map(([testName, transitions]) => `
        <div class="border border-gray-100 rounded-lg overflow-hidden">
          <div class="px-3 py-2 bg-gray-50 border-b border-gray-100 flex items-center gap-2">
            <span class="w-1.5 h-1.5 rounded-full ${transitions[0].to === 'quarantine' ? 'bg-yellow-400' : 'bg-green-400'} flex-shrink-0"></span>
            <p class="text-xs font-medium text-gray-700 truncate flex-1" title="${escapeHtml(testName)}">${escapeHtml(testName)}</p>
            <span class="text-xs text-gray-400 shrink-0">${transitions.length} event${transitions.length !== 1 ? 's' : ''}</span>
          </div>
          <div class="divide-y divide-gray-50">
            ${transitions.map((tr) => `
              <div class="px-3 py-2 flex items-center gap-3 flex-wrap text-xs">
                <span class="text-gray-400 shrink-0">${tr.date}</span>
                <span class="flex items-center gap-1">
                  ${transitionBadge(tr.from)}
                  <span class="text-gray-400">→</span>
                  ${transitionBadge(tr.to)}
                </span>
                ${tr.strikes != null && tr.strikes !== 'null' && tr.strikes !== 'unknown' ? `
                  <span class="text-yellow-600 font-medium">&#9889; ${tr.strikes} strike${tr.strikes !== '1' ? 's' : ''}</span>
                ` : ''}
                ${tr.runUrl ? `
                  <a href="${escapeHtml(tr.runUrl)}" target="_blank" class="text-blue-600 hover:underline ml-auto">View Run &#8599;</a>
                ` : ''}
              </div>
            `).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

// ── Allow List Status ──

async function refreshAllowList() {
  setHTML('#allowlist-content', skeletonBlock());
  try {
    const [status, disallowStatus, restoreRuns] = await Promise.all([
      FTApi.checkAllowListStatus(),
      FTApi.checkDisallowListStatus(),
      FTApi.getRestoreRuns(5),
    ]);
    allowListData = status;

    const totalOwned = Object.values(FILE_TEST_COUNTS).reduce((a, b) => a + b, 0);
    const onAllowCount = status.ownedOnAllow.length;
    const onDisallowCount = disallowStatus.ownedOnDisallow.length;

    // Derive "never added" — tests not on either list
    // Use simple subtraction from total: never added = total - on allow - on disallow
    // Clamp to 0 in case matchTitleToFile patterns are stale
    const neverAddedCount = Math.max(0, totalOwned - onAllowCount - onDisallowCount);

    // Also compute per-file breakdown for the detail view
    const neverAddedByFile = {};
    for (const fileKey of FILE_MATCH_ORDER) {
      const expected = FILE_TEST_COUNTS[fileKey] || 0;
      const onAllow = status.ownedOnAllow.filter((t) => matchTitleToFile(t.title) === fileKey).length;
      const onDisallow = disallowStatus.ownedOnDisallow.filter((t) => matchTitleToFile(t.title) === fileKey).length;
      const missing = Math.max(0, expected - onAllow - onDisallow);
      if (missing > 0) neverAddedByFile[fileKey] = missing;
    }

    const notOnAllowCount = onDisallowCount + neverAddedCount;
    if (notOnAllowCount > 0) {
      summaryIssues.push(`${notOnAllowCount} of ${totalOwned} owned tests not on allow list`);
    }

    let html = '<div class="space-y-3">';

    // Summary line
    html += `
      <div class="text-sm text-gray-600">
        <span class="font-semibold">${totalOwned}</span> owned tests:
        <span class="text-green-600 font-medium">${onAllowCount} on allow list</span>,
        ${onDisallowCount > 0 ? `<span class="text-yellow-600 font-medium">${onDisallowCount} on disallow list</span>,` : ''}
        <span class="${neverAddedCount > 0 ? 'text-red-600' : 'text-green-600'} font-medium">${neverAddedCount} never added</span>
      </div>
    `;

    // On Allow List — collapsible
    html += `
      <details class="group">
        <summary class="flex items-center gap-2 cursor-pointer hover:opacity-80">
          <span class="text-lg text-green-600">&#10003;</span>
          <span class="text-green-600 font-semibold">${onAllowCount} on allow list</span>
          <span class="text-gray-400 text-xs ml-auto group-open:rotate-90 transition-transform">&#9654;</span>
        </summary>
        ${onAllowCount > 0 ? `
          <ul class="mt-2 text-xs text-gray-600 list-disc list-inside max-h-40 overflow-y-auto pl-1 space-y-0.5">
            ${status.ownedOnAllow.map((t) => `<li class="truncate" title="${t.title}">${t.title}</li>`).join('')}
          </ul>
        ` : '<p class="mt-2 text-xs text-gray-400">No owned tests on allow list</p>'}
      </details>
    `;

    // On Disallow List — collapsible with restore buttons
    if (onDisallowCount > 0) {
      const restoreAllGrep = disallowStatus.ownedOnDisallow.map((t) => t.Title || t.title).join('|');
      html += `
        <details class="group">
          <summary class="flex items-center gap-2 cursor-pointer hover:opacity-80">
            <span class="text-lg text-yellow-600">&#9888;</span>
            <span class="text-yellow-600 font-semibold">${onDisallowCount} on disallow list</span>
            <span class="text-gray-400 text-xs ml-auto group-open:rotate-90 transition-transform">&#9654;</span>
          </summary>
          <div class="mt-2 space-y-1">
            <div class="flex items-center justify-between mb-2">
              <p class="text-xs text-gray-400">Quarantined tests eligible for restoration</p>
              <button onclick="dispatchRestore('${escapeHtml(restoreAllGrep)}')" class="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-white bg-yellow-600 hover:bg-yellow-700 rounded-md transition-colors">
                &#9654; Restore all LAFing Cow
              </button>
            </div>
            <div class="max-h-48 overflow-y-auto space-y-1">
              ${disallowStatus.ownedOnDisallow.map((t) => {
                const title = t.Title || t.title;
                const strikes = t.Strikes || '0';
                const dateAdded = t['Date Added'] ? timeAgo(t['Date Added']) : '';
                return `
                  <div class="flex items-center justify-between py-1.5 px-2 rounded hover:bg-yellow-50 border-b border-gray-100 last:border-0">
                    <div class="min-w-0 mr-2">
                      <div class="text-xs text-gray-700 truncate" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
                      <div class="text-xs text-gray-400">
                        ${strikes !== '0' ? `<span class="text-yellow-600">Strikes: ${strikes}</span>` : ''}
                        ${dateAdded ? `<span class="ml-1">Added ${dateAdded}</span>` : ''}
                      </div>
                    </div>
                    <button onclick="event.stopPropagation(); dispatchRestore('${escapeHtml(title)}')" class="shrink-0 px-2 py-0.5 text-xs text-yellow-700 hover:text-white hover:bg-yellow-600 border border-yellow-300 rounded transition-colors" title="Restore this test">
                      Restore
                    </button>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        </details>
      `;
    }

    // Never Added — tests not on either list
    if (neverAddedCount > 0) {
      html += `
        <details class="group">
          <summary class="flex items-center gap-2 cursor-pointer hover:opacity-80">
            <span class="text-lg text-red-600">&#10007;</span>
            <span class="text-red-600 font-semibold">${neverAddedCount} never added</span>
            <span class="text-gray-400 text-xs ml-auto group-open:rotate-90 transition-transform">&#9654;</span>
          </summary>
          <div class="mt-2">
            <p class="text-xs text-gray-400 mb-2">Not on either list &mdash; these tests don't run in PRCI</p>
            <ul class="text-xs text-gray-600 space-y-0.5 pl-1">
              ${Object.entries(neverAddedByFile).map(([fileKey, count]) => {
                const filePath = FTApi.OWNED_TEST_FILES.find((f) => f.toLowerCase().includes(fileKey)) || fileKey;
                const fileName = filePath.split('/').pop();
                return `<li class="truncate" title="${filePath}">${fileName}: <span class="text-red-600 font-medium">${count} test${count !== 1 ? 's' : ''} missing</span></li>`;
              }).join('')}
            </ul>
          </div>
        </details>
      `;
    }

    // Recent restore runs
    if (restoreRuns.length > 0) {
      html += `
        <details class="group mt-1">
          <summary class="flex items-center gap-2 cursor-pointer hover:opacity-80 text-sm">
            <span class="text-gray-500">Recent restore runs</span>
            <span class="text-gray-400 text-xs ml-auto group-open:rotate-90 transition-transform">&#9654;</span>
          </summary>
          <div class="mt-1 max-h-40 overflow-y-auto">
            <table class="w-full text-xs">
              <thead><tr class="text-gray-400">
                <th class="text-left px-2 py-1">Status</th>
                <th class="text-left px-2 py-1">When</th>
                <th class="text-left px-2 py-1">Link</th>
              </tr></thead>
              <tbody>
                ${restoreRuns.map((r) => `
                  <tr class="border-t border-gray-100">
                    <td class="px-2 py-1">${statusBadge(r.conclusion || r.status)}</td>
                    <td class="px-2 py-1 text-gray-500" title="${formatDate(r.createdAt)}">${timeAgo(r.createdAt)}</td>
                    <td class="px-2 py-1"><a href="${r.url}" target="_blank" class="text-blue-600 hover:underline">View</a>${copyLinkBtn(r.url)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </details>
      `;
    }

    // Test History panel — loads lazily after the rest of the card renders
    const historyUpdated = testHistoryData?.lastUpdated
      ? `<span class="text-xs text-gray-400 ml-1">(updated ${testHistoryData.lastUpdated})</span>`
      : '';
    html += `
      <details class="group mt-1">
        <summary class="flex items-center gap-2 cursor-pointer hover:opacity-80 text-sm">
          <span class="text-gray-500">&#128197; Test transition history</span>
          ${historyUpdated}
          <span class="text-gray-400 text-xs ml-auto group-open:rotate-90 transition-transform">&#9654;</span>
        </summary>
        <div class="mt-2" id="test-history-panel-content">
          <div class="text-xs text-gray-400 italic py-2">Loading history&hellip;</div>
        </div>
      </details>
    `;

    html += '</div>';
    setHTML('#allowlist-content', html);

    // Lazy-load history after card is painted
    FTApi.fetchTestHistory().then((history) => {
      testHistoryData = history;
      const el = document.getElementById('test-history-panel-content');
      if (el) el.innerHTML = renderTestHistoryPanel(history);
    }).catch(() => {
      const el = document.getElementById('test-history-panel-content');
      if (el) el.innerHTML = '<div class="text-xs text-red-400 py-2">Could not load history</div>';
    });
  } catch (err) {
    setHTML(
      '#allowlist-content',
      `<p class="text-red-500 text-sm">Error: ${err.message}</p>
       <p class="text-gray-400 text-xs mt-1">Ensure your token has the read:project scope</p>`
    );
  }
}

// ── PRCI Runs (Cross-PR Spikes) ──

async function refreshPRCIRuns() {
  setHTML('#spike-content', skeletonBlock());
  try {
    const runs = await FTApi.getPRCIRuns(75);

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentRuns = runs.filter((r) => new Date(r.createdAt) > cutoff);

    // Only count runs that include lafingcow tests (team-specific dispatches)
    // "ALL" dispatches run every team — a failure there doesn't mean OUR tests failed
    const lafingcowRuns = recentRuns.filter((r) =>
      r.name.toLowerCase().includes('lafingcow')
    );
    const failedRuns = lafingcowRuns.filter((r) => r.conclusion === 'failure');
    prciFailedRuns = failedRuns;

    const branchFailures = new Map();
    for (const run of failedRuns) {
      if (!branchFailures.has(run.branch)) {
        branchFailures.set(run.branch, []);
      }
      branchFailures.get(run.branch).push(run);
    }

    const totalLafingcow = lafingcowRuns.length;
    const failedCount = failedRuns.length;
    const uniqueBranches = branchFailures.size;

    if (uniqueBranches >= 3) {
      summaryIssues.push(`Cross-PR spike: LAFing Cow failures across ${uniqueBranches} branches in 24h`);
    }

    let html = `
      <div class="space-y-3">
        <div class="grid grid-cols-3 gap-4 text-sm">
          <div>
            <span class="text-gray-500">LAFing Cow Runs (24h)</span>
            <p class="font-mono text-lg">${totalLafingcow}</p>
          </div>
          <div>
            <span class="text-gray-500">Failed</span>
            <p class="font-mono text-lg ${failedCount > 0 ? 'text-red-600' : ''}">${failedCount}</p>
          </div>
          <div>
            <span class="text-gray-500">Branches w/ Failures</span>
            <p class="font-mono text-lg ${uniqueBranches >= 3 ? 'text-red-600' : ''}">${uniqueBranches}</p>
          </div>
        </div>
    `;

    if (uniqueBranches >= 3) {
      html += `
        <div class="p-3 bg-red-50 border border-red-200 rounded-lg">
          <p class="text-red-800 font-medium text-sm">Spike Detected: LAFing Cow failures across ${uniqueBranches} branches in 24h</p>
          <p class="text-red-600 text-xs mt-1">This may indicate a flaky owned test or broken main.</p>
        </div>
      `;
    } else if (failedCount === 0) {
      html += `
        <div class="flex items-center gap-2 text-green-600 text-sm">
          <span>&#10003;</span> No LAFing Cow failures in the last 24 hours
        </div>
      `;
    }

    if (failedRuns.length > 0) {
      html += `
        <details class="mt-2">
          <summary class="text-sm text-gray-500 cursor-pointer hover:text-gray-700">
            Show ${failedRuns.length} failed runs
          </summary>
          <div class="mt-1 max-h-48 overflow-y-auto">
            <table class="w-full text-xs">
              <thead><tr class="text-gray-400">
                <th class="text-left px-2 py-1">Branch</th>
                <th class="text-left px-2 py-1">When</th>
                <th class="text-left px-2 py-1">Link</th>
              </tr></thead>
              <tbody>
                ${failedRuns
                  .map(
                    (r) => `
                  <tr class="border-t border-gray-100">
                    <td class="px-2 py-1">${branchLink(r.branch)}</td>
                    <td class="px-2 py-1 text-gray-500" title="${formatDate(r.createdAt)}">${timeAgo(r.createdAt)}</td>
                    <td class="px-2 py-1"><a href="${r.url}" target="_blank" class="text-blue-600 hover:underline">View</a>${copyLinkBtn(r.url)}</td>
                  </tr>
                `
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </details>
      `;
    }

    html += '</div>';
    setHTML('#spike-content', html);
  } catch (err) {
    setHTML(
      '#spike-content',
      `<p class="text-red-500 text-sm">Error: ${err.message}</p>`
    );
  }
}

// ── Owned Test Health ──

// Total test count per file (from grep -c "test('" in each file)
const FILE_TEST_COUNTS = {
  'storedetails': 5,
  'storeroutes': 7,
  'modalityselectorv2': 7,
  'modalityselector-authenticatedv2': 7,
  'modalityselectorv2-auth-delivery': 4,
  'firstaddtocart': 12,
  'firstaddtocart-accessibility': 5,
  'modalityselector-accessibility': 5,
};

// Known test names per file — used to match allow/disallow list titles to specific files.
// These are lowercased substrings matched via includes(). Keep in sync with actual test() titles.
const FILE_TEST_NAMES = {
  'storedetails': [
    'store-details page and display correct information',
    'content toggles collapse/expand',
    'start my cart from ways to shop - pickup',
    'start my cart from ways to shop - delivery',
    'accessibility scan for store-details',
  ],
  'storeroutes': [
    'input zip and search for stores',
    'select pickup filter',
    'through view store details link',
    'accessibility with search results populated',
    'through store name links',
    'accessibility with no search results',
  ],
  'modalityselectorv2': [
    'should open modality as basic entry',
    'should be able to set modality to delivery',
    'modalityselector v2 should be able to set modality to kroger delivery',
    'should be able to set modality to pickup',
    'should be able to set modality to in-store',
    'should display geolocation button',
    'should display addressbook - unauth',
  ],
  'modalityselector-authenticatedv2': [
    'authenticated should open modality',
    'authenticated should be able to set modality to delivery',
    'authenticated should be able to set modality to kroger delivery',
    'should display modality addressbook from schedule delivery',
    'modalityselectorv2 authenticated should be able to set modality to pickup',
    'modalityselectorv2 authenticated should be able to set modality to in-store',
    'modalityselectorv2 authenticated should display geolocation',
  ],
  'modalityselectorv2-auth-delivery': [
    'kroger delivery time-slot',
    'edit reservation to another timeslot',
    'reserve timslot from scheduler',
    'select kroger delivery, schedule delivery',
  ],
  'firstaddtocart': [
    'first add to cart modal',
    'close first add to cart',
    'modality cards for available modalities',
    'add to cart button when store pickup',
    'save to list button when in-store',
    'navigate to store selection screen',
    'navigate back from store selection screen',
    'search postal code in store selection',
    'select a store from store selection screen',
    'navigate to address book when changing delivery',
    'navigate back from address book to main modality',
    'select an address in address book and confirm',
  ],
  'firstaddtocart-accessibility': [
    'accessibility violations on modality selection screen (store pickup',
    'accessibility violations on modality selection screen (in-store selected',
    'violations on store selection screen with search results',
    'violations on store selection screen',
    'accessibility violations on address book screen',
  ],
  'modalityselector-accessibility': [
    'violations on pickup tab',
    'violations on delivery tab',
    'violations on in-store tab',
    'violations on signin screen',
    'violations on authenticated screen',
  ],
};

// Order matters — check specific files before generic catch-alls
const FILE_MATCH_ORDER = [
  'storedetails',
  'storeroutes',
  'firstaddtocart-accessibility',
  'firstaddtocart',
  'modalityselectorv2-auth-delivery',
  'modalityselector-authenticatedv2',
  'modalityselector-accessibility',
  'modalityselectorv2',  // most generic — last
];

function matchTitleToFile(title) {
  const t = title.toLowerCase();
  for (const fileKey of FILE_MATCH_ORDER) {
    const patterns = FILE_TEST_NAMES[fileKey];
    if (patterns && patterns.some((p) => t.includes(p))) return fileKey;
  }
  return null;
}

function getTestHealth(filePath) {
  const fileName = filePath.split('/').pop().replace('.func.ts', '').toLowerCase();
  const totalTests = FILE_TEST_COUNTS[fileName] || 0;

  // Count how many of this file's tests are on the allow list
  if (allowListData?.ownedOnAllow?.length > 0) {
    const onAllow = allowListData.ownedOnAllow.filter(
      (t) => matchTitleToFile(t.title) === fileName
    );
    const notOnAllow = totalTests - onAllow.length;
    if (notOnAllow > 0) {
      return { status: 'red', label: `${onAllow.length} of ${totalTests} on allow list` };
    }
  } else if (totalTests > 0) {
    // No allow list data loaded yet or 0 owned on allow list
    return { status: 'red', label: `0 of ${totalTests} on allow list` };
  }

  // Check PRCI failures
  if (prciFailedRuns.length > 0) {
    const patterns = FILE_TEST_NAMES[fileName];
    if (patterns) {
      const matchCount = prciFailedRuns.filter((r) => {
        const name = r.name.toLowerCase();
        return patterns.some((p) => name.includes(p));
      }).length;
      if (matchCount >= 2) {
        return { status: 'yellow', label: `${matchCount} failures (24h)` };
      }
    }
  }

  return { status: 'green', label: `${totalTests} of ${totalTests} on allow list` };
}

function renderOwnedTests() {
  const grid = $('#owned-tests-grid');
  if (!grid) return;

  const statusColors = {
    green: { bg: 'bg-green-50 border-green-200', dot: 'bg-green-500', text: 'text-green-700' },
    yellow: { bg: 'bg-yellow-50 border-yellow-200', dot: 'bg-yellow-500', text: 'text-yellow-700' },
    red: { bg: 'bg-red-50 border-red-200', dot: 'bg-red-500', text: 'text-red-700' },
  };

  const html = FTApi.OWNED_TEST_FILES.map((filePath) => {
    const parts = filePath.split('/');
    const fileName = parts.pop();
    const pkg = parts.slice(0, -1).join('/');
    const health = getTestHealth(filePath);
    const colors = statusColors[health.status];

    // Link to allow list filtered to lafingcow
    const projectUrl = `${ALLOW_LIST_URL}?filterQuery=lafing`;

    return `
      <a href="${projectUrl}" target="_blank"
         class="block p-3 rounded-lg border ${colors.bg} hover:shadow-sm transition group">
        <div class="flex items-center gap-2 mb-1">
          <span class="w-2 h-2 rounded-full ${colors.dot} flex-shrink-0"></span>
          <p class="text-sm font-medium text-gray-700 group-hover:text-blue-600 truncate">${fileName}</p>
        </div>
        <p class="text-xs text-gray-400 truncate">${pkg}</p>
        <p class="text-xs ${colors.text} mt-1">${health.label}</p>
      </a>
    `;
  }).join('');

  grid.innerHTML = html;
}

// ── Dispatch Buttons ──

function setupDispatchButtons() {
  $('#dispatch-lafingcow-btn')?.addEventListener('click', async () => {
    const btn = $('#dispatch-lafingcow-btn');
    const ref = $('#dispatch-ref-input')?.value?.trim() || 'main';

    const confirmed = await confirmDispatch(
      `Dispatch LAFing Cow FTs on "${ref}"? This triggers a CI run (~20 min) using shared resources.`
    );
    if (!confirmed) return;

    btn.disabled = true;
    btn.textContent = 'Dispatching...';

    try {
      const result = await FTApi.dispatchLafingcowFTs(ref);
      showToast(result.message, 'success');
      setTimeout(() => refreshLafingcowRuns(), 5000);
    } catch (err) {
      showToast(`Dispatch failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Run LAFing Cow FTs';
    }
  });

  $('#dispatch-string-btn')?.addEventListener('click', async () => {
    const btn = $('#dispatch-string-btn');
    const grepInput = $('#grep-string-input');
    const grep = grepInput?.value?.trim();

    if (!grep) {
      showToast('Enter a test grep string', 'error');
      return;
    }

    const ref = $('#dispatch-ref-input')?.value?.trim() || 'main';

    const confirmed = await confirmDispatch(
      `Run tests matching "${grep}" on "${ref}"? This triggers a CI run with 5 repeats.`
    );
    if (!confirmed) return;

    btn.disabled = true;
    btn.textContent = 'Dispatching...';

    try {
      const result = await FTApi.dispatchByString(grep, ref);
      showToast(result.message, 'success');
    } catch (err) {
      showToast(`Dispatch failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Run';
    }
  });

  $('#refresh-btn')?.addEventListener('click', refreshAll);
}

// ── Copy Link ──

function copyLinkBtn(url) {
  return `<button onclick="copyToClipboard('${url}')" class="text-gray-400 hover:text-gray-600 text-xs ml-1" title="Copy link">&#128203;</button>`;
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => showToast('Link copied', 'info'));
}
window.copyToClipboard = copyToClipboard;

// ── Toast Notifications ──

function showToast(message, type = 'info') {
  const container = $('#toast-container');
  if (!container) return;

  const colors = {
    success: 'bg-green-600',
    error: 'bg-red-600',
    info: 'bg-blue-600',
  };

  const toast = document.createElement('div');
  toast.className = `${colors[type]} text-white px-4 py-3 rounded-lg shadow-lg text-sm transform transition-all duration-300 translate-y-2 opacity-0`;
  toast.textContent = message;
  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  });

  setTimeout(() => {
    toast.classList.add('translate-y-2', 'opacity-0');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ── Table helpers ──

function skeletonRows(cols, count) {
  return Array.from({ length: count }, () =>
    `<tr><td colspan="${cols}" class="px-4 py-3"><div class="skeleton w-full"></div></td></tr>`
  ).join('');
}

function skeletonBlock() {
  return `<div class="space-y-2">${Array.from({ length: 3 }, () => '<div class="skeleton w-full"></div>').join('')}</div>`;
}

function emptyRow(cols, msg) {
  return `<tr><td colspan="${cols}" class="px-4 py-6 text-center text-gray-400 text-sm">${msg}</td></tr>`;
}

function errorRow(cols, msg) {
  return `<tr><td colspan="${cols}" class="px-4 py-6 text-center text-red-400 text-sm">Error: ${msg}</td></tr>`;
}

function renderTable(selector, rows, rowRenderer, cols) {
  if (rows.length === 0) {
    setHTML(selector, emptyRow(cols, 'No data'));
    return;
  }

  if (rows.length <= DEFAULT_ROWS) {
    setHTML(selector, rows.map(rowRenderer).join(''));
    return;
  }

  const toggleId = `tgl-${Math.random().toString(36).slice(2, 8)}`;
  const visibleHtml = rows.slice(0, DEFAULT_ROWS).map(rowRenderer).join('');
  const extraRows = rows.slice(DEFAULT_ROWS).map((r) => {
    const html = rowRenderer(r);
    // Hide the data row; also hide any detail sub-rows (id starts with "detail-")
    return html
      .replace('<tr', `<tr data-tgl="${toggleId}" style="display:none"`)
      .replace(/<tr id="(detail-[^"]+)" class="hidden"/g, `<tr id="$1" class="hidden" data-tgl="${toggleId}" style="display:none"`);
  }).join('');

  setHTML(selector, `
    ${visibleHtml}
    ${extraRows}
    <tr data-tgl-ctrl="${toggleId}">
      <td colspan="${cols}" class="px-4 py-2 text-center">
        <button class="text-xs text-blue-600 hover:text-blue-800 font-medium"
          data-tgl-btn="${toggleId}" data-total="${rows.length}" data-default="${DEFAULT_ROWS}">
          Show all ${rows.length} rows
        </button>
      </td>
    </tr>
  `);

  const btn = document.querySelector(`[data-tgl-btn="${toggleId}"]`);
  btn?.addEventListener('click', () => {
    const hiddenRows = document.querySelectorAll(`[data-tgl="${toggleId}"]`);
    const isHidden = hiddenRows[0]?.style.display === 'none';
    hiddenRows.forEach((row) => {
      row.style.display = isHidden ? '' : 'none';
      // When collapsing, also hide expanded detail rows and reset parent styling
      if (!isHidden && row.id?.startsWith('detail-')) {
        row.classList.add('hidden');
        const parentRow = row.previousElementSibling;
        parentRow?.classList.remove('bg-red-50');
        const chevron = parentRow?.querySelector('[data-chevron]');
        if (chevron) chevron.innerHTML = '&#9660;';
      }
    });
    btn.textContent = isHidden
      ? `Show ${DEFAULT_ROWS} rows`
      : `Show all ${rows.length} rows`;
  });
}

// ── Init ──

document.addEventListener('DOMContentLoaded', () => {
  setupAuth();
});
