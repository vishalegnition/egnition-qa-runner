import fs from 'fs';
import path from 'path';

const SESSION_DIR = process.env.SESSION_STORE_DIR || path.join(process.cwd(), 'data');
const SESSION_FILE = path.join(SESSION_DIR, 'shopify-session.json');

export function savePersistedSession(storageStateBase64) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(
    SESSION_FILE,
    JSON.stringify({ storageStateBase64, savedAt: Date.now() }, null, 0)
  );
  console.log('Saved persistent Shopify session');
}

export function loadPersistedSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    return data.storageStateBase64 ?? null;
  } catch {
    return null;
  }
}

export function getPersistedSessionMeta() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function hasPersistedSession() {
  return Boolean(loadPersistedSession());
}

export function clearPersistedSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
    console.log('Cleared persistent Shopify session');
  } catch {
    /* ignore */
  }
}
