/**
 * GitHub API wrapper for FT Dashboard
 * Uses Octokit REST + GraphQL for querying esperanto repo data
 */

const OWNER = 'krogertechnology';
const REPO = 'esperanto';
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

// Owned test names (LAFing Cow team)
const OWNED_TEST_FILES = [
  '@kroger/store/kroger-store-details/pw_tests/StoreDetails.func.ts',
  '@kroger/store/kroger-store-tests/pw_tests/StoreRoutes.func.ts',
  '@kroger/core/modality-selector-ui/pw_tests/ModalitySelectorV2.func.ts',
  '@kroger/core/modality-selector-ui/pw_tests/ModalitySelector-authenticatedV2.func.ts',
  '@kroger/core/modality-selector-ui/pw_tests/ModalitySelectorV2-auth-delivery.func.ts',
];

let octokit = null;

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

async function initOctokit() {
  const token = getToken();
  if (!token) throw new Error('No token configured');
  // Use globalThis.Octokit from CDN
  octokit = new Octokit({ auth: token });
  return octokit;
}

function getOctokit() {
  if (!octokit) throw new Error('Octokit not initialized. Call initOctokit() first.');
  return octokit;
}

// ── Workflow Runs ──

async function getWorkflowRuns(workflowKey, { branch, limit = 10 } = {}) {
  const wf = WORKFLOWS[workflowKey];
  if (!wf) throw new Error(`Unknown workflow: ${workflowKey}`);

  const params = {
    owner: OWNER,
    repo: REPO,
    workflow_id: wf.id,
    per_page: limit,
  };
  if (branch) params.branch = branch;

  const { data } = await getOctokit().request(
    'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs',
    params
  );

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
  await getOctokit().request(
    'POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches',
    {
      owner: OWNER,
      repo: REPO,
      workflow_id: WORKFLOWS.dispatchFTs.file,
      ref,
      inputs: { 'team-config-name': 'lafingcow' },
    }
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

  await getOctokit().request(
    'POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches',
    {
      owner: OWNER,
      repo: REPO,
      workflow_id: WORKFLOWS.dispatchByString.file,
      ref,
      inputs,
    }
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
    const result = await getOctokit().graphql(query, {
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

  // Extract test titles from project items
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

  // Check each owned test file's tests against the lists
  // Note: We don't have the actual test names client-side,
  // so we check the allow list for known test patterns
  const result = {
    allowListTotal: allowTitles.size,
    disallowListTotal: disallowTitles.size,
    ownedOnAllow: [],
    ownedOnDisallow: [],
    ownedMissing: [],
  };

  // Search for tests matching owned file patterns
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
  // Get recent PRCI workflow runs that contain FTs
  const params = {
    owner: OWNER,
    repo: REPO,
    workflow_id: WORKFLOWS.dispatchFTs.id,
    per_page: limit,
  };

  const { data } = await getOctokit().request(
    'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs',
    params
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
  initOctokit,
  getWorkflowRuns,
  getLafingcowRuns,
  dispatchLafingcowFTs,
  dispatchByString,
  checkAllowListStatus,
  getPRCIRuns,
};
