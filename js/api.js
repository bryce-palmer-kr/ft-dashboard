/**
 * GitHub API wrapper for FT Dashboard
 * Uses plain fetch — no Octokit dependency
 */

const OWNER = 'krogertechnology';
const REPO = 'esperanto';
const API = 'https://api.github.com';
const GQL = 'https://api.github.com/graphql';
const ALLOW_LIST_PROJECT = 266;
const DISALLOW_LIST_PROJECT = 277;

// Workflow IDs (from esperanto repo)
const WORKFLOWS = {
  dispatchFTs: {
    id: 206030848,
    name: '01 PRCI - Execute FTs from functionalTests.js',
    file: '01-PRCI-dispatchFunctionalTests.yml',
  },
  dispatchByString: {
    id: 138768977,
    name: '01 PRCI - Execute FTs by String (Man)',
    file: '01-PRCI-dispatchFunctionalTestString.yml',
  },
  mainFailures: {
    id: 194363007,
    name: '03 Util - Run FTs against Main and Log Failures (Sch)',
    file: '03-Util-log-ft-failures-against-main.yml',
  },
  mainQmetry: {
    id: 138768995,
    name: '02 RC - Dispatch FTs Against Main With Qmetry Upload (Sch)',
    file: '02-RC-functionalMain.yml',
  },
  quarantineReport: {
    id: 138769002,
    name: '03 Util - FT Skip List Report (Sch)',
    file: '03-Util-FTQuarantineReport.yml',
  },
  restoreToAllowlist: {
    id: 233959656,
    name: '03 Util - Restore FTs to Allowlist after validation (Sch)',
    file: '03-Util-restore-fts-to-allowlist.yml',
  },
  flakinessDaily: {
    id: 138769014,
    name: '04 Metrics - Dispatch Daily FT False Positive Report (Sch)',
    file: '04-Metrics-FTFlakinessReportDaily.yml',
  },
};

// Owned test files (LAFing Cow team)
const OWNED_TEST_FILES = [
  '@kroger/store/kroger-store-details/pw_tests/StoreDetails.func.ts',
  '@kroger/store/kroger-store-tests/pw_tests/StoreRoutes.func.ts',
  '@kroger/core/modality-selector-ui/pw_tests/ModalitySelectorV2.func.ts',
  '@kroger/core/modality-selector-ui/pw_tests/ModalitySelector-authenticatedV2.func.ts',
  '@kroger/core/modality-selector-ui/pw_tests/ModalitySelectorV2-auth-delivery.func.ts',
];

// ── Token management ──

function getToken() {
  return localStorage.getItem('gh_token');
}

function setToken(token) {
  localStorage.setItem('gh_token', token);
}

function clearToken() {
  localStorage.removeItem('gh_token');
}

function isAuthenticated() {
  return !!getToken();
}

// ── HTTP helpers ──

function headers() {
  const token = getToken();
  if (!token) throw new Error('No token configured');
  return {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function ghGet(path) {
  const res = await fetch(`${API}${path}`, { headers: headers() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `GitHub API ${res.status}`);
  }
  return res.json();
}

async function ghPost(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // 204 = success with no content (dispatches return this)
  if (res.status === 204) return {};
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || `GitHub API ${res.status}`);
  }
  return res.json();
}

async function ghGraphQL(query, variables) {
  const res = await fetch(GQL, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) {
    throw new Error(data.errors.map((e) => e.message).join('; '));
  }
  return data.data;
}

async function verifyToken() {
  return ghGet('/user');
}

// ── Workflow Runs ──

async function getWorkflowRuns(workflowKey, { branch, limit = 10 } = {}) {
  const wf = WORKFLOWS[workflowKey];
  if (!wf) throw new Error(`Unknown workflow: ${workflowKey}`);

  let url = `/repos/${OWNER}/${REPO}/actions/workflows/${wf.id}/runs?per_page=${limit}`;
  if (branch) url += `&branch=${encodeURIComponent(branch)}`;

  const data = await ghGet(url);

  return data.workflow_runs.map((run) => ({
    id: run.id,
    name: run.display_title || run.name,
    status: run.status,
    conclusion: run.conclusion,
    branch: run.head_branch,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    url: run.html_url,
    runNumber: run.run_number,
    attempt: run.run_attempt,
  }));
}

async function getLafingcowRuns(limit = 10) {
  const allRuns = await getWorkflowRuns('dispatchFTs', { limit: 50 });
  return allRuns
    .filter((r) => r.name.toLowerCase().includes('lafingcow'))
    .slice(0, limit);
}

// ── Dispatch Workflows ──

async function dispatchLafingcowFTs(ref = 'main') {
  await ghPost(
    `/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOWS.dispatchFTs.file}/dispatches`,
    { ref, inputs: { 'team-config-name': 'lafingcow' } }
  );
  return { success: true, message: 'Dispatched lafingcow FTs on ' + ref };
}

async function dispatchByString(grepString, ref = 'main', options = {}) {
  const inputs = {
    'grep-string': grepString,
    'project-desktop-chrome': String(options.desktopChrome ?? true),
    'project-mobile-chrome': String(options.mobileChrome ?? true),
    'repeat-each': String(options.repeatEach ?? 5),
    'pw-workers': String(options.workers ?? 5),
  };

  await ghPost(
    `/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOWS.dispatchByString.file}/dispatches`,
    { ref, inputs }
  );
  return { success: true, message: `Dispatched FTs for "${grepString}" on ${ref}` };
}

// ── Allow List (GitHub Projects GraphQL) ──

async function queryProjectItems(projectNumber) {
  const query = `
    query($org: String!, $number: Int!, $cursor: String) {
      organization(login: $org) {
        projectV2(number: $number) {
          items(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              fieldValues(first: 10) {
                nodes {
                  ... on ProjectV2ItemFieldTextValue {
                    text
                    field { ... on ProjectV2FieldCommon { name } }
                  }
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name
                    field { ... on ProjectV2FieldCommon { name } }
                  }
                  ... on ProjectV2ItemFieldDateValue {
                    date
                    field { ... on ProjectV2FieldCommon { name } }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const allItems = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const result = await ghGraphQL(query, {
      org: OWNER,
      number: projectNumber,
      cursor,
    });

    const items = result.organization.projectV2.items;
    allItems.push(...items.nodes);
    hasNextPage = items.pageInfo.hasNextPage;
    cursor = items.pageInfo.endCursor;
  }

  return allItems;
}

function normalizeTestName(text) {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

async function checkAllowListStatus() {
  const [allowItems, disallowItems] = await Promise.all([
    queryProjectItems(ALLOW_LIST_PROJECT),
    queryProjectItems(DISALLOW_LIST_PROJECT),
  ]);

  function extractTitles(items) {
    const titles = new Map();
    for (const item of items) {
      const fields = {};
      for (const fv of item.fieldValues.nodes) {
        if (fv?.field?.name && (fv.text || fv.name || fv.date)) {
          fields[fv.field.name] = fv.text || fv.name || fv.date;
        }
      }
      if (fields.Title) {
        titles.set(normalizeTestName(fields.Title), fields);
      }
    }
    return titles;
  }

  const allowTitles = extractTitles(allowItems);
  const disallowTitles = extractTitles(disallowItems);

  const result = {
    allowListTotal: allowTitles.size,
    disallowListTotal: disallowTitles.size,
    ownedOnAllow: [],
    ownedOnDisallow: [],
    ownedMissing: [],
  };

  const ownedPatterns = [
    'storedetails',
    'storeroutes',
    'store details',
    'store routes',
    'modality',
    'modalityselector',
    'first add to cart',
    'firstaddtocart',
  ];

  for (const [title, fields] of allowTitles) {
    if (ownedPatterns.some((p) => title.includes(p))) {
      result.ownedOnAllow.push({ title, ...fields });
    }
  }

  for (const [title, fields] of disallowTitles) {
    if (ownedPatterns.some((p) => title.includes(p))) {
      result.ownedOnDisallow.push({ title, ...fields });
    }
  }

  return result;
}

// ── PRCI Runs (Cross-PR Spike Detection) ──

async function getPRCIRuns(limit = 30) {
  const data = await ghGet(
    `/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOWS.dispatchFTs.id}/runs?per_page=${limit}`
  );

  return data.workflow_runs.map((run) => ({
    id: run.id,
    name: run.display_title || run.name,
    conclusion: run.conclusion,
    branch: run.head_branch,
    createdAt: run.created_at,
    url: run.html_url,
    prNumber: run.pull_requests?.[0]?.number,
  }));
}

// ── Export ──

window.FTApi = {
  WORKFLOWS,
  OWNED_TEST_FILES,
  getToken,
  setToken,
  clearToken,
  isAuthenticated,
  verifyToken,
  getWorkflowRuns,
  getLafingcowRuns,
  dispatchLafingcowFTs,
  dispatchByString,
  checkAllowListStatus,
  getPRCIRuns,
};
