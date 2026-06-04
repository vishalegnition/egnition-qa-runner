/**
 * Zephyr Scale API client — fetches test cycles and test cases.
 * API docs: https://support.smartbear.com/zephyr-scale-cloud/api-docs/
 */

const BASE = () => process.env.ZEPHYR_BASE_URL?.replace(/\/$/, '');
const TOKEN = () => process.env.ZEPHYR_API_TOKEN;

async function zephyrFetch(path) {
  const url = `${BASE()}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN()}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Zephyr API ${res.status}: ${path} — ${body.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }

  return res.json();
}

/**
 * Fetch test cycle metadata and associated test case keys.
 * @param {string} cycleId - e.g. CYCLE-42
 */
export async function fetchTestCycle(cycleId) {
  return zephyrFetch(`/rest/atm/1.0/testrun/${encodeURIComponent(cycleId)}`);
}

/**
 * Fetch full test case including steps.
 * @param {string} testcaseKey - e.g. TC-001
 */
export async function fetchTestCase(testcaseKey) {
  return zephyrFetch(`/rest/atm/1.0/testcase/${encodeURIComponent(testcaseKey)}`);
}

/**
 * Extract test case keys from a cycle response.
 * Handles common Zephyr response shapes.
 */
function extractTestCaseKeys(cycle) {
  const items =
    cycle.items ??
    cycle.testCases ??
    cycle.testcases ??
    cycle.links ??
    [];

  if (Array.isArray(items) && items.length > 0) {
    return items.map((item) => {
      if (typeof item === 'string') return item;
      return (
        item.testCaseKey ??
        item.key ??
        item.testcaseKey ??
        item.testCase?.key
      );
    }).filter(Boolean);
  }

  if (cycle.testCaseKeys && Array.isArray(cycle.testCaseKeys)) {
    return cycle.testCaseKeys;
  }

  return [];
}

/**
 * Normalize steps from a test case into a consistent shape.
 */
function normalizeSteps(testCase) {
  const raw =
    testCase.testScript?.steps ??
    testCase.steps ??
    testCase.testScriptSteps ??
    [];

  return raw.map((s, index) => ({
    index: index + 1,
    step: s.step ?? s.description ?? s.action ?? '',
    testData: s.testData ?? s.data ?? '',
    expectedResult: s.expectedResult ?? s.expected ?? '',
  }));
}

/**
 * Fetch all test cases (with steps) for a cycle.
 * @param {string} cycleId
 * @returns {Promise<{ cycle: object, testCases: Array<{ key: string, name: string, steps: object[] }> }>}
 */
export async function fetchCycleWithTestCases(cycleId) {
  const cycle = await fetchTestCycle(cycleId);
  const keys = extractTestCaseKeys(cycle);

  if (keys.length === 0) {
    const err = new Error(`No test cases found in cycle ${cycleId}`);
    err.code = 'EMPTY_CYCLE';
    throw err;
  }

  const testCases = [];
  for (const key of keys) {
    const tc = await fetchTestCase(key);
    testCases.push({
      key,
      name: tc.name ?? tc.summary ?? key,
      steps: normalizeSteps(tc),
    });
  }

  return { cycle, testCases };
}

// CLI: node runner/zephyr.js [cycle-id]
if (process.argv[1]?.endsWith('zephyr.js')) {
  const cycleId = process.argv[2] ?? process.env.CYCLE_ID;
  if (!cycleId) {
    console.error('Usage: node runner/zephyr.js <cycle-id>');
    process.exit(1);
  }
  fetchCycleWithTestCases(cycleId)
    .then(({ testCases }) => {
      console.log(JSON.stringify(testCases, null, 2));
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
