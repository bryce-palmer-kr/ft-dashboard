/**
 * Dashboard UI logic
 * Renders cards, handles dispatch buttons, refreshes data
 */

// ── State ──
let isLoading = false;
let lastRefresh = null;

// ── DOM Helpers ──

function $(selector) {
  return document.querySelector(selector);
}

function $$(selector) {
  return document.querySelectorAll(selector);
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

// ── Auth ──

function setupAuth() {
  const authSection = $('#auth-section');
  const dashboardSection = $('#dashboard-section');
  const tokenInput = $('#token-input');
  const authBtn = $('#auth-btn');
  const logoutBtn = $('#logout-btn');
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
      await FTApi.initOctokit();

      // Verify token works
      const ok = new Octokit({ auth: token });
      const { data: user } = await ok.request('GET /user');
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

  // Enter key on input
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
    await FTApi.initOctokit();
    const ok = new Octokit({ auth: FTApi.getToken() });
    const { data: user } = await ok.request('GET /user');
    setText('#user-name', user.login);
  } catch {
    // token expired
    FTApi.clearToken();
    location.reload();
    return;
  }

  setupLogout();
  setupDispatchButtons();
  refreshAll();
}

// ── Data Refresh ──

async function refreshAll() {
  if (isLoading) return;
  isLoading = true;
  setText('#refresh-status', 'Refreshing...');

  try {
    await Promise.allSettled([
      refreshMainRuns(),
      refreshLafingcowRuns(),
      refreshAllowList(),
      refreshPRCIRuns(),
    ]);

    lastRefresh = new Date();
    setText('#refresh-status', `Last updated: ${formatDate(lastRefresh.toISOString())}`);
  } catch (err) {
    setText('#refresh-status', `Error: ${err.message}`);
  } finally {
    isLoading = false;
  }
}

// ── Main Branch Runs ──

async function refreshMainRuns() {
  setHTML('#main-runs-body', loadingRow(4));
  try {
    const runs = await FTApi.getWorkflowRuns('mainFailures', { limit: 10 });
    if (runs.length === 0) {
      setHTML('#main-runs-body', emptyRow(4, 'No runs found'));
      return;
    }

    const passCount = runs.filter((r) => r.conclusion === 'success').length;
    const failCount = runs.filter((r) => r.conclusion === 'failure').length;
    setText('#main-pass-count', passCount);
    setText('#main-fail-count', failCount);

    const html = runs
      .map(
        (r) => `
      <tr class="hover:bg-gray-50">
        <td class="px-4 py-2 text-sm">${statusBadge(r.conclusion || r.status)}</td>
        <td class="px-4 py-2 text-sm text-gray-600">${timeAgo(r.createdAt)}</td>
        <td class="px-4 py-2 text-sm text-gray-500">${r.branch}</td>
        <td class="px-4 py-2 text-sm">
          <a href="${r.url}" target="_blank" class="text-blue-600 hover:underline">View</a>
        </td>
      </tr>
    `
      )
      .join('');
    setHTML('#main-runs-body', html);
  } catch (err) {
    setHTML('#main-runs-body', errorRow(4, err.message));
  }
}

// ── LAFing Cow Dispatch Runs ──

async function refreshLafingcowRuns() {
  setHTML('#lafingcow-runs-body', loadingRow(5));
  try {
    const runs = await FTApi.getLafingcowRuns(10);
    if (runs.length === 0) {
      setHTML('#lafingcow-runs-body', emptyRow(5, 'No lafingcow runs found'));
      return;
    }

    const html = runs
      .map(
        (r) => `
      <tr class="hover:bg-gray-50">
        <td class="px-4 py-2 text-sm">${statusBadge(r.conclusion || r.status)}</td>
        <td class="px-4 py-2 text-sm text-gray-600">${timeAgo(r.createdAt)}</td>
        <td class="px-4 py-2 text-sm text-gray-500">${r.branch}</td>
        <td class="px-4 py-2 text-sm text-gray-500 truncate max-w-xs">${r.name}</td>
        <td class="px-4 py-2 text-sm">
          <a href="${r.url}" target="_blank" class="text-blue-600 hover:underline">View</a>
        </td>
      </tr>
    `
      )
      .join('');
    setHTML('#lafingcow-runs-body', html);
  } catch (err) {
    setHTML('#lafingcow-runs-body', errorRow(5, err.message));
  }
}

// ── Allow List Status ──

async function refreshAllowList() {
  setHTML('#allowlist-content', '<p class="text-gray-400 text-sm">Loading...</p>');
  try {
    const status = await FTApi.checkAllowListStatus();

    const onAllowCount = status.ownedOnAllow.length;
    const onDisallowCount = status.ownedOnDisallow.length;
    const isHealthy = onDisallowCount === 0;

    const headerColor = isHealthy ? 'text-green-600' : 'text-red-600';
    const headerIcon = isHealthy ? 'check-circle' : 'exclamation-triangle';

    let html = `
      <div class="space-y-3">
        <div class="flex items-center gap-2 ${headerColor} font-semibold">
          <span class="text-lg">${isHealthy ? '&#10003;' : '&#9888;'}</span>
          <span>${onAllowCount} owned tests on allow list</span>
        </div>
        <div class="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span class="text-gray-500">Allow List Total</span>
            <p class="font-mono text-lg">${status.allowListTotal}</p>
          </div>
          <div>
            <span class="text-gray-500">Disallow List Total</span>
            <p class="font-mono text-lg">${status.disallowListTotal}</p>
          </div>
        </div>
    `;

    if (onDisallowCount > 0) {
      html += `
        <div class="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg">
          <p class="text-red-800 font-medium text-sm mb-2">Quarantined Tests (${onDisallowCount})</p>
          <ul class="text-sm text-red-700 list-disc list-inside">
            ${status.ownedOnDisallow.map((t) => `<li>${t.title}</li>`).join('')}
          </ul>
        </div>
      `;
    }

    if (onAllowCount > 0) {
      html += `
        <details class="mt-2">
          <summary class="text-sm text-gray-500 cursor-pointer hover:text-gray-700">
            Show ${onAllowCount} tests on allow list
          </summary>
          <ul class="mt-1 text-xs text-gray-600 list-disc list-inside max-h-48 overflow-y-auto">
            ${status.ownedOnAllow.map((t) => `<li>${t.title}</li>`).join('')}
          </ul>
        </details>
      `;
    }

    html += '</div>';
    setHTML('#allowlist-content', html);
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
  setHTML('#spike-content', '<p class="text-gray-400 text-sm">Loading...</p>');
  try {
    const runs = await FTApi.getPRCIRuns(30);

    // Filter to last 24h
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentRuns = runs.filter((r) => new Date(r.createdAt) > cutoff);
    const failedRuns = recentRuns.filter((r) => r.conclusion === 'failure');

    // Group failures by branch to detect spikes
    const branchFailures = new Map();
    for (const run of failedRuns) {
      const branch = run.branch;
      if (!branchFailures.has(branch)) {
        branchFailures.set(branch, []);
      }
      branchFailures.get(branch).push(run);
    }

    const totalRuns24h = recentRuns.length;
    const failedCount = failedRuns.length;
    const uniqueBranches = branchFailures.size;

    let html = `
      <div class="space-y-3">
        <div class="grid grid-cols-3 gap-4 text-sm">
          <div>
            <span class="text-gray-500">Runs (24h)</span>
            <p class="font-mono text-lg">${totalRuns24h}</p>
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
          <p class="text-red-800 font-medium text-sm">Spike Detected: Failures across ${uniqueBranches} branches in 24h</p>
          <p class="text-red-600 text-xs mt-1">This may indicate a systemic issue (flaky test, infra, or broken main).</p>
        </div>
      `;
    } else if (failedCount === 0) {
      html += `
        <div class="flex items-center gap-2 text-green-600 text-sm">
          <span>&#10003;</span> No failures in the last 24 hours
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
                    <td class="px-2 py-1 text-gray-700 truncate max-w-[200px]">${r.branch}</td>
                    <td class="px-2 py-1 text-gray-500">${timeAgo(r.createdAt)}</td>
                    <td class="px-2 py-1"><a href="${r.url}" target="_blank" class="text-blue-600 hover:underline">View</a></td>
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

// ── Dispatch Buttons ──

function setupDispatchButtons() {
  // Dispatch lafingcow FTs
  $('#dispatch-lafingcow-btn')?.addEventListener('click', async () => {
    const btn = $('#dispatch-lafingcow-btn');
    const ref = $('#dispatch-ref-input')?.value?.trim() || 'main';
    btn.disabled = true;
    btn.textContent = 'Dispatching...';

    try {
      const result = await FTApi.dispatchLafingcowFTs(ref);
      showToast(result.message, 'success');
      // Refresh runs after a short delay to let GitHub process
      setTimeout(() => refreshLafingcowRuns(), 5000);
    } catch (err) {
      showToast(`Dispatch failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Run LAFing Cow FTs';
    }
  });

  // Dispatch by string
  $('#dispatch-string-btn')?.addEventListener('click', async () => {
    const btn = $('#dispatch-string-btn');
    const grepInput = $('#grep-string-input');
    const grep = grepInput?.value?.trim();

    if (!grep) {
      showToast('Enter a test grep string', 'error');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Dispatching...';

    try {
      const result = await FTApi.dispatchByString(grep);
      showToast(result.message, 'success');
    } catch (err) {
      showToast(`Dispatch failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Run';
    }
  });

  // Refresh button
  $('#refresh-btn')?.addEventListener('click', refreshAll);
}

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

  // Animate in
  requestAnimationFrame(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  });

  // Remove after 4s
  setTimeout(() => {
    toast.classList.add('translate-y-2', 'opacity-0');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ── Table helpers ──

function loadingRow(cols) {
  return `<tr><td colspan="${cols}" class="px-4 py-6 text-center text-gray-400 text-sm">Loading...</td></tr>`;
}

function emptyRow(cols, msg) {
  return `<tr><td colspan="${cols}" class="px-4 py-6 text-center text-gray-400 text-sm">${msg}</td></tr>`;
}

function errorRow(cols, msg) {
  return `<tr><td colspan="${cols}" class="px-4 py-6 text-center text-red-400 text-sm">Error: ${msg}</td></tr>`;
}

// ── Auto-refresh ──

function startAutoRefresh(intervalMs = 5 * 60 * 1000) {
  setInterval(() => {
    if (document.visibilityState === 'visible' && FTApi.isAuthenticated()) {
      refreshAll();
    }
  }, intervalMs);
}

// ── Init ──

document.addEventListener('DOMContentLoaded', () => {
  setupAuth();
  startAutoRefresh();
});
