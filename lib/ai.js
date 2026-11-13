// gather — on-air AI research assistant.
// Streams an answer as plain text from the provider the host chose, using the host's own API key.
// Keys arrive with each request and are never stored or logged here.
const Anthropic = require('@anthropic-ai/sdk');

const SYSTEM = [
  'You are the on-air research assistant inside a live stream studio called gather.',
  'Your answers are shown on screen to a live audience, so write for reading at a glance:',
  'lead with the answer, keep it under about 120 words unless asked for more, use short paragraphs or a few bullet points,',
  'no tables, no code blocks unless asked, and no markdown headings.',
  'When you look something up, name your sources briefly in plain words (for example "per Reuters, March 2026").',
  'If you are not sure, say so plainly.',
].join(' ');

const PROVIDERS = {
  claude: { label: 'Claude', model: 'claude-opus-5-5' },
  openai: { label: 'ChatGPT', model: 'gpt-5.5' },
  gemini: { label: 'Gemini', model: 'gemini-2.5-flash' },
  grok: { label: 'Grok', model: 'grok-4.7' },
};

class AIError extends Error { constructor(status, message) { super(message); this.status = status; } }

function cleanMessages(list) {
  // Only plain text turns from the page; alternate roles, start with the user, max 30 turns.
  const out = [];
  for (const m of (Array.isArray(list) ? list : []).slice(-30)) {
    const role = m?.role === 'assistant' ? 'assistant' : 'user';
    const text = String(m?.text ?? '').slice(0, 8000);
    if (!text.trim()) continue;
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].text += '\n\n' + text;
    else out.push({ role, text });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  if (!out.length || out[out.length - 1].role !== 'user') throw new AIError(400, 'Ask a question first.');
  return out;
}

/**
 * Stream an answer. `write(text)` is called for each piece of text as it arrives.
 * Resolves with { model, note } when finished.
 */
async function streamAnswer({ provider, apiKey, model, messages }, write) {
  const p = PROVIDERS[provider];
  if (!p) throw new AIError(400, 'Choose Claude, ChatGPT, Gemini or Grok.');
  if (!apiKey || String(apiKey).length < 10) throw new AIError(400, `Add your ${p.label} API key in the AI panel.`);
  const msgs = cleanMessages(messages);
  const useModel = String(model || p.model).trim().slice(0, 80);
  if (provider === 'claude') return streamClaude(apiKey, useModel, msgs, write);
  if (provider === 'gemini') return streamGemini(apiKey, useModel, msgs, write);
  const base = provider === 'grok' ? 'https://api.x.ai/v1' : 'https://api.openai.com/v1';
  return streamOpenAIStyle(base, p.label, apiKey, useModel, msgs, write);
}

// ---- Claude: official SDK, web search for research, server-side refusal fallback ----------------
async function streamClaude(apiKey, model, msgs, write) {
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 120_000 });
  let messages = msgs.map((m) => ({ role: m.role, content: m.text }));
  let note = '';
  try {
    // A server-side tool loop can pause; resume a few times at most.
    for (let turn = 0; turn < 4; turn++) {
      const stream = client.beta.messages.stream({
        model,
        max_tokens: 64000,
        system: SYSTEM,
        output_config: { effort: 'medium' },
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4 }],
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        messages,
      });
      stream.on('text', (t) => write(t));
      const final = await stream.finalMessage();
      if (final.stop_reason === 'refusal') { note = 'Claude declined to answer that.'; break; }
      if (final.stop_reason !== 'pause_turn') break;
      messages = [...messages, { role: 'assistant', content: final.content }];
    }
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new AIError(401, 'Claude rejected the API key. Check it in the AI panel.');
    if (e instanceof Anthropic.NotFoundError) throw new AIError(400, `Claude does not recognise the model "${model}".`);
    if (e instanceof Anthropic.RateLimitError) throw new AIError(429, 'Claude is rate limiting this key. Wait a moment and ask again.');
    if (e instanceof Anthropic.BadRequestError) throw new AIError(400, 'Claude: ' + e.message);
    if (e instanceof Anthropic.APIError) throw new AIError(502, `Claude error ${e.status}: ${e.message}`);
    throw e;
  }
  return { model, note };
}

// ---- OpenAI-compatible chat completions (ChatGPT, Grok) ------------------------------------------
async function streamOpenAIStyle(base, label, apiKey, model, msgs, write) {
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'system', content: SYSTEM }, ...msgs.map((m) => ({ role: m.role, content: m.text }))] }),
  });
  if (!res.ok) throw await providerError(res, label, model);
  await readSSE(res, (data) => { const t = data?.choices?.[0]?.delta?.content; if (t) write(t); });
  return { model, note: '' };
}

// ---- Gemini ---------------------------------------------------------------------------------------
async function streamGemini(apiKey, model, msgs, write) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: msgs.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] })),
      tools: [{ google_search: {} }],
    }),
  });
  if (!res.ok) throw await providerError(res, 'Gemini', model);
  await readSSE(res, (data) => {
    for (const part of data?.candidates?.[0]?.content?.parts || []) if (part.text) write(part.text);
  });
  return { model, note: '' };
}

async function providerError(res, label, model) {
  let detail = '';
  try { const j = await res.json(); detail = j?.error?.message || j?.message || ''; } catch {}
  if (res.status === 401 || res.status === 403) return new AIError(401, `${label} rejected the API key. Check it in the AI panel.`);
  if (res.status === 404) return new AIError(400, `${label} does not recognise the model "${model}". ${detail}`.trim());
  if (res.status === 429) return new AIError(429, `${label} is rate limiting this key, or the account is out of credit. ${detail}`.trim());
  return new AIError(502, `${label} error ${res.status}. ${detail}`.trim());
}

async function readSSE(res, onData) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { onData(JSON.parse(payload)); } catch {}
    }
  }
}

// ---- images (thumbnails) -------------------------------------------------------------------------
const IMAGE_MODELS = { openai: 'gpt-image-1', grok: 'grok-2-image', gemini: 'imagen-3.0-generate-002' };
async function generateImage({ provider, apiKey, prompt, model }) {
  prompt = String(prompt || '').trim().slice(0, 1500);
  if (!prompt) throw new AIError(400, 'Describe the image you want.');
  if (!apiKey || String(apiKey).length < 10) throw new AIError(400, 'Add your API key in the AI panel first.');
  if (provider === 'claude') throw new AIError(400, 'Claude doesn’t make images. Pick ChatGPT, Gemini or Grok in the AI panel for AI thumbnails.');
  const full = `${prompt}. Wide 16:9 YouTube thumbnail background, bold and high contrast, no text, no letters, no watermark.`;
  const useModel = String(model || IMAGE_MODELS[provider] || '').slice(0, 80);
  let res, b64;
  if (provider === 'openai' || provider === 'grok') {
    const base = provider === 'grok' ? 'https://api.x.ai/v1' : 'https://api.openai.com/v1';
    const body = provider === 'openai' ? { model: useModel, prompt: full, size: '1536x1024', n: 1 } : { model: useModel, prompt: full, n: 1, response_format: 'b64_json' };
    res = await fetch(base + '/images/generations', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw await providerError(res, provider === 'grok' ? 'Grok' : 'ChatGPT', useModel);
    const j = await res.json();
    b64 = j?.data?.[0]?.b64_json;
    if (!b64 && j?.data?.[0]?.url) { const img = await fetch(j.data[0].url); b64 = Buffer.from(await img.arrayBuffer()).toString('base64'); }
  } else if (provider === 'gemini') {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(useModel)}:predict`, {
      method: 'POST', headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ instances: [{ prompt: full }], parameters: { sampleCount: 1, aspectRatio: '16:9' } }),
    });
    if (!res.ok) throw await providerError(res, 'Gemini', useModel);
    b64 = (await res.json())?.predictions?.[0]?.bytesBase64Encoded;
  } else throw new AIError(400, 'Choose ChatGPT, Gemini or Grok for images.');
  if (!b64) throw new AIError(502, 'The image service returned no image. Try a different description.');
  return { data: 'data:image/png;base64,' + b64 };
}

/** Shared HTTP handler for Vercel (api/ai.js) and server.js. Streams text/plain. */
async function handleAI(req, res, body) {
  if (body?.mode === 'image') {
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
    try { const out = await generateImage(body); res.statusCode = 200; res.end(JSON.stringify(out)); }
    catch (e) { res.statusCode = e.status || 500; if (!(e instanceof AIError)) console.error('[gather ai image]', e); res.end(JSON.stringify({ error: e instanceof AIError ? e.message : 'The image request failed. Try again.' })); }
    return;
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  let started = false;
  try {
    const out = await streamAnswer(body || {}, (t) => {
      if (!started) { res.statusCode = 200; started = true; }
      res.write(t);
    });
    if (out.note) res.write((started ? '\n\n' : '') + out.note);
    res.end();
  } catch (e) {
    const msg = e instanceof AIError ? e.message : 'The AI request failed. Try again.';
    if (!(e instanceof AIError)) console.error('[gather ai]', e);
    if (!started) { res.statusCode = e.status || 500; res.end(msg); }
    else res.end('\n\n[' + msg + ']');
  }
}

module.exports = { handleAI, streamAnswer, PROVIDERS };
