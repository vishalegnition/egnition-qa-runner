const SYSTEM_PROMPT = `You are a Shopify QA automation agent. You are given a screenshot of a Shopify admin
page or storefront and a test step written in plain English.

Your job is to determine the next browser action to take to complete that step.

Respond ONLY in JSON with one of the following formats:

  { "action": "click", "target": "<description of element to click>" }
  { "action": "fill", "target": "<field description>", "value": "<text to enter>" }
  { "action": "navigate", "url": "<full URL>" }
  { "action": "scroll", "direction": "down" }
  { "action": "wait", "seconds": 2 }
  { "action": "assert", "result": "PASS", "reason": "<what you observed>" }
  { "action": "assert", "result": "FAIL", "reason": "<what you observed>" }

Never include any text outside the JSON object.`;

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODELS_URL = 'https://openrouter.ai/api/v1/models';
const FALLBACK_MODEL = 'google/gemini-2.0-flash-exp';

let cachedModel = null;

/**
 * Score Gemini vision models — higher is better.
 * Prefers newer flash models (fast + strong for screenshot QA).
 */
export function pickBestGeminiVisionModel(models) {
  const candidates = (models ?? [])
    .map((m) => ({ model: m, score: scoreGeminiVisionModel(m) }))
    .filter((c) => c.score >= 0)
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.model?.id ?? null;
}

function scoreGeminiVisionModel(model) {
  const id = model.id ?? '';
  if (!id.startsWith('google/gemini')) return -1;

  const inputs = model.architecture?.input_modalities ?? [];
  if (!inputs.includes('image')) return -1;
  if (model.expiration_date) return -1;

  let score = 0;

  // Flash models are preferred for QA automation (speed + cost).
  if (/\bflash\b/i.test(id) || id.includes('flash-')) score += 200;
  else if (/\bpro\b/i.test(id)) score += 120;

  const version = id.match(/gemini-(\d+)\.(\d+)/);
  if (version) {
    score += Number(version[1]) * 20 + Number(version[2]) * 5;
  }

  // Slight preference for stable over preview/experimental when scores tie.
  if (id.includes('preview') || id.includes('-exp')) score -= 8;

  score += (model.created ?? 0) / 1e10;

  return score;
}

async function resolveModel(apiKey) {
  if (process.env.OPENROUTER_MODEL) {
    return process.env.OPENROUTER_MODEL;
  }
  if (cachedModel) return cachedModel;

  try {
    const res = await fetch(MODELS_URL, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    if (!res.ok) {
      throw new Error(`models API ${res.status}`);
    }
    const { data } = await res.json();
    cachedModel = pickBestGeminiVisionModel(data) ?? FALLBACK_MODEL;
    console.log(`Auto-selected OpenRouter model: ${cachedModel}`);
  } catch (err) {
    console.warn(
      `Could not auto-select Gemini model (${err.message}); using ${FALLBACK_MODEL}`
    );
    cachedModel = FALLBACK_MODEL;
  }

  return cachedModel;
}

/**
 * Build user message with step context and screenshot.
 */
function buildUserMessage(stepText, expectedResult, screenshotBase64) {
  let text = `Test step:\n${stepText}`;
  if (expectedResult) {
    text += `\n\nExpected result:\n${expectedResult}`;
  }
  text += '\n\nRespond with the next JSON action only.';

  return {
    role: 'user',
    content: [
      { type: 'text', text },
      {
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${screenshotBase64}` },
      },
    ],
  };
}

/**
 * Extract JSON object from model response (handles markdown fences).
 */
export function parseModelResponse(raw) {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = fenceMatch ? fenceMatch[1].trim() : trimmed;

  const start = jsonStr.indexOf('{');
  const end = jsonStr.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('No JSON object in model response');
  }

  return JSON.parse(jsonStr.slice(start, end + 1));
}

async function callOpenRouter(messages) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is required');
  }

  const model = await resolveModel(apiKey);

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/egnition-qa-runner',
      'X-Title': 'Egnition QA Runner',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
      temperature: 0.1,
      max_tokens: 1024,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Empty response from OpenRouter');
  }
  return content;
}

/**
 * Query vision model with screenshot + step. Retries once after 5s on failure.
 */
export async function getNextAction(screenshotBuffer, stepText, expectedResult = '') {
  const base64 = screenshotBuffer.toString('base64');
  const messages = [buildUserMessage(stepText, expectedResult, base64)];

  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await callOpenRouter(messages);
      try {
        return parseModelResponse(raw);
      } catch (parseErr) {
        console.error('Raw model response:', raw);
        throw new Error('invalid model response');
      }
    } catch (err) {
      lastError = err;
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  const err = new Error(`AI service unavailable: ${lastError?.message}`);
  err.cause = lastError;
  throw err;
}
