/**
 * Fetch shared credentials from Railway at the start of each local run.
 */

export async function fetchConfig() {
  const url = process.env.RAILWAY_CONFIG_URL?.trim();
  const secret = process.env.RAILWAY_CONFIG_SECRET?.trim();

  if (!url || !secret) {
    throw new Error(
      'RAILWAY_CONFIG_URL and RAILWAY_CONFIG_SECRET must be set in .env (pre-configured by admin)'
    );
  }

  const response = await fetch(url, {
    headers: { 'x-config-secret': secret },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Failed to fetch config from Railway (${response.status}): ${body.slice(0, 200)}`);
  }

  return response.json();
}

/** Apply Railway config to process.env for shared runner modules. */
export function applyConfig(config) {
  if (config.zephyr?.apiToken) process.env.ZEPHYR_API_TOKEN = config.zephyr.apiToken;
  if (config.zephyr?.baseUrl) process.env.ZEPHYR_BASE_URL = config.zephyr.baseUrl;
  if (config.zephyr?.apiUrl) process.env.ZEPHYR_API_URL = config.zephyr.apiUrl;

  if (config.openrouter?.apiKey) process.env.OPENROUTER_API_KEY = config.openrouter.apiKey;
  if (config.openrouter?.model) process.env.OPENROUTER_MODEL = config.openrouter.model;

  if (config.slack?.botToken) process.env.SLACK_BOT_TOKEN = config.slack.botToken;
  if (config.slack?.channelId) process.env.SLACK_CHANNEL_ID = config.slack.channelId;
}
