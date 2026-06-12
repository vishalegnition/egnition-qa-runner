import fs from 'fs';
import os from 'os';
import path from 'path';

const MAX_RUNS = 50;

export function historyPath() {
  const home = process.env.EGNITION_QA_HOME || path.join(os.homedir(), '.egnition-qa-runner');
  return path.join(home, 'history.json');
}

export function loadHistory() {
  const file = historyPath();
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function saveRun(entry) {
  const file = historyPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const history = loadHistory();
  history.unshift(entry);
  fs.writeFileSync(file, JSON.stringify(history.slice(0, MAX_RUNS), null, 2));
}
