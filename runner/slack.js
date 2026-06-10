import fs from 'fs';
import path from 'path';
import { WebClient } from '@slack/web-api';

function getClient() {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error('SLACK_BOT_TOKEN is required');
  return new WebClient(token);
}

function formatDuration(ms) {
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

const SLACK_TEXT_LIMIT = 3900;

export function summarizeResults(results) {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const rate = results.length ? Math.round((passed / results.length) * 100) : 0;
  return { passed, failed, total: results.length, rate };
}

function shortenReason(reason, max = 120) {
  const oneLine = String(reason ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return oneLine.length > max ? `${oneLine.slice(0, max).trim()}…` : oneLine;
}

/**
 * Build the text report per spec Section 7.
 */
export function buildReport({
  appName,
  cycleId,
  startedAt,
  durationMs,
  results,
  maxReasonLen = 120,
}) {
  const { passed, failed, total, rate } = summarizeResults(results);
  const startStr = startedAt.toISOString().slice(11, 16) + ' UTC';

  let body = `QA Run Complete — ${appName} | Cycle: ${cycleId}\n`;
  body += `Started: ${startStr} | Duration: ${formatDuration(durationMs)}\n\n`;
  body += `Total: ${total}   Passed: ${passed}   Failed: ${failed}   Pass rate: ${rate}%\n\n`;

  for (const r of results) {
    const icon = r.passed ? '✅' : '❌';
    body += `${icon} ${r.key}: ${r.name}\n`;
    if (!r.passed && r.reason) {
      body += `   Reason: ${shortenReason(r.reason, maxReasonLen)}\n`;
      if (r.screenshotPath) {
        body += `   Screenshot: [attached]\n`;
      }
    }
    body += '\n';
  }

  return body.trim();
}

/** Split a long report into Slack-safe chunks. */
export function chunkReport(text, limit = SLACK_TEXT_LIMIT) {
  if (text.length <= limit) return [text];

  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function buildProgressFinished(cycleId, results) {
  const { passed, failed, total, rate } = summarizeResults(results);
  const icon = failed === 0 ? '✅' : passed === 0 ? '❌' : '⚠️';
  return (
    `${icon} *${cycleId}* finished — ${passed}/${total} passed (${rate}%) · posting results…`
  );
}

/**
 * Post summary message and upload screenshots in thread.
 */
export async function postResults({
  appName,
  cycleId,
  startedAt,
  durationMs,
  results,
  slackChannel,
}) {
  const channel = slackChannel || process.env.SLACK_CHANNEL_ID;
  if (!channel) throw new Error('SLACK_CHANNEL_ID is required');

  const client = getClient();
  const text = buildReport({ appName, cycleId, startedAt, durationMs, results });
  const chunks = chunkReport(text);

  const summary = await client.chat.postMessage({
    channel,
    text: chunks[0],
  });

  const threadTs = summary.ts;

  for (let i = 1; i < chunks.length; i++) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: chunks[i],
    });
  }

  for (const r of results) {
    if (!r.screenshotPath || !fs.existsSync(r.screenshotPath)) continue;

    const status = r.passed ? 'pass' : 'fail';
    const filename = `${cycleId}-${r.key}-${status}.png`;

    await client.files.uploadV2({
      channel_id: channel,
      thread_ts: threadTs,
      file: fs.createReadStream(r.screenshotPath),
      filename,
      title: `${r.key} — ${status}`,
    });
  }

  return { threadTs, channel };
}

/**
 * Post or update a short live-progress message during a test run.
 * Pass `updateTs` to edit the same message instead of spamming the channel.
 */
export async function postRunProgress(text, slackChannel, updateTs) {
  const channel = slackChannel || process.env.SLACK_CHANNEL_ID;
  if (!channel || !process.env.SLACK_BOT_TOKEN) return updateTs ?? null;

  try {
    const client = getClient();
    if (updateTs) {
      await client.chat.update({ channel, ts: updateTs, text });
      return updateTs;
    }
    const msg = await client.chat.postMessage({ channel, text });
    return msg.ts;
  } catch (err) {
    console.error('Slack progress post failed:', err.message);
    return updateTs ?? null;
  }
}

/**
 * Post a simple error message to the QA channel.
 */
export async function postError(message, slackChannel) {
  const channel = slackChannel || process.env.SLACK_CHANNEL_ID;
  if (!channel) {
    console.error('Slack error (no channel):', message);
    return;
  }
  const client = getClient();
  await client.chat.postMessage({ channel, text: `⚠️ QA Runner Error\n${message}` });
}

/**
 * Ensure screenshot directory exists; return file path.
 */
export function screenshotPath(cycleId, testCaseKey, status) {
  const dir = path.join(process.cwd(), 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${cycleId}-${testCaseKey}-${status}.png`);
}
