/**
 * Zephyr Scale for Jira Cloud API client (v2).
 * Docs: https://support.smartbear.com/zephyr-scale-cloud/api-docs/
 *
 * Cycle keys look like BR-R104 (project key + cycle id).
 */

const API_BASE = () =>
  (process.env.ZEPHYR_API_URL || 'https://api.zephyrscale.smartbear.com/v2').replace(
    /\/$/,
    ''
  );
const TOKEN = () => process.env.ZEPHYR_API_TOKEN;

async function zephyrFetch(path) {
  const url = path.startsWith('http') ? path : `${API_BASE()}${path}`;
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

async function zephyrFetchAll(firstPath) {
  const items = [];
  let path = firstPath;

  while (path) {
    const page = await zephyrFetch(path);
    if (Array.isArray(page.values)) {
      items.push(...page.values);
    } else if (Array.isArray(page)) {
      items.push(...page);
      break;
    }
    path = page.isLast || !page.next ? null : page.next;
  }

  return items;
}

function testCaseKeyFromExecution(execution) {
  const self = execution.testCase?.self ?? '';
  const match = self.match(/\/testcases\/([^/]+)/);
  return match?.[1] ?? null;
}

/**
 * Fetch test cycle metadata.
 * @param {string} cycleKey - e.g. BR-R104
 */
export async function fetchTestCycle(cycleKey) {
  return zephyrFetch(`/testcycles/${encodeURIComponent(cycleKey)}`);
}

/**
 * Fetch full test case metadata.
 * @param {string} testcaseKey - e.g. BR-T56
 */
export async function fetchTestCase(testcaseKey) {
  return zephyrFetch(`/testcases/${encodeURIComponent(testcaseKey)}`);
}

/**
 * Fetch test steps for a test case.
 */
export async function fetchTestSteps(testcaseKey) {
  return zephyrFetchAll(
    `/testcases/${encodeURIComponent(testcaseKey)}/teststeps?maxResults=100`
  );
}

/**
 * Normalize steps from Zephyr Scale v2 response.
 */
function normalizeSteps(rawSteps, precondition) {
  const steps = rawSteps.map((s, index) => {
    const inline = s.inline ?? s;
    return {
      index: index + 1,
      step: inline.description ?? inline.step ?? s.description ?? '',
      testData: inline.testData ?? inline.data ?? '',
      expectedResult: inline.expectedResult ?? inline.expected ?? '',
    };
  });

  if (precondition?.trim()) {
    steps.unshift({
      index: 0,
      step: `Precondition: ${precondition.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`,
      testData: '',
      expectedResult: 'Preconditions are satisfied before executing the test steps.',
    });
  }

  return steps.map((s, i) => ({ ...s, index: i + 1 }));
}

/**
 * Fetch all test executions in a cycle, then load each test case + steps.
 * @param {string} cycleKey - e.g. BR-R104
 */
export async function fetchCycleWithTestCases(cycleKey) {
  const cycle = await fetchTestCycle(cycleKey);

  const executions = await zephyrFetchAll(
    `/testexecutions?testCycle=${encodeURIComponent(cycleKey)}&maxResults=100`
  );

  if (executions.length === 0) {
    const err = new Error(`No test executions found in cycle ${cycleKey}`);
    err.code = 'EMPTY_CYCLE';
    throw err;
  }

  const seen = new Set();
  const testCases = [];

  for (const execution of executions) {
    const key = testCaseKeyFromExecution(execution);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const tc = await fetchTestCase(key);
    const rawSteps = await fetchTestSteps(key);

    testCases.push({
      key,
      executionKey: execution.key,
      name: tc.name ?? key,
      steps: normalizeSteps(rawSteps, tc.precondition),
    });
  }

  if (testCases.length === 0) {
    const err = new Error(`No test cases found in cycle ${cycleKey}`);
    err.code = 'EMPTY_CYCLE';
    throw err;
  }

  return { cycle, testCases };
}

// CLI: node runner/zephyr.js [cycle-key]
if (process.argv[1]?.endsWith('zephyr.js')) {
  const cycleKey = process.argv[2] ?? process.env.CYCLE_ID;
  if (!cycleKey) {
    console.error('Usage: node runner/zephyr.js <cycle-key>');
    process.exit(1);
  }
  fetchCycleWithTestCases(cycleKey)
    .then(({ cycle, testCases }) => {
      console.log(
        JSON.stringify(
          {
            cycle: { key: cycle.key, name: cycle.name, total: testCases.length },
            testCases,
          },
          null,
          2
        )
      );
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
