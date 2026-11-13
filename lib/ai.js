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

// ---- AI producer: understands the host, answers, and returns actions for the studio ----------------------
function producerPrompt(ctx) {
  const name = String(ctx?.name || 'Sam').slice(0, 24);
  const scenes = (ctx?.scenes || []).slice(0, 40).map((x) => String(x).slice(0, 40));
  const library = (ctx?.library || []).slice(0, 40).map((x) => `${String(x.name).slice(0, 50)} (${x.kind})`);
  return [
    `You are ${name}, the on-air producer for a live show in a browser studio called gather. The host talks to you on air, like a producer in the booth who pulls things up on screen.`,
    'Reply with ONE JSON object and nothing else, in this shape:',
    '{"say": "what you say out loud, one or two short sentences", "show": "optional longer text to put on screen (facts, a short summary with sources), or empty", "actions": [ ... ]}',
    'Actions you can take (use only these):',
    '{"type":"open","url":"https://…","label":"short title"} — pull up a web page or video on screen. For YouTube, give a direct https://www.youtube.com/watch?v=… link when you know it, otherwise a YouTube search link https://www.youtube.com/results?search_query=…',
    '{"type":"scene","name":"exact scene name"} — switch the stage layout.',
    '{"type":"present","name":"exact library item name"} — put a file from the media library on screen.',
    '{"type":"stop"} — stop whatever is being presented.',
    '{"type":"banner","text":"…","sub":"optional"} and {"type":"hide_banner"} — lower-third headline.',
    '{"type":"countdown","minutes":5} — on-stage countdown.',
    `Scenes available: ${scenes.length ? scenes.join(', ') : 'none listed'}.`,
    `Media library: ${library.length ? library.join(', ') : 'empty'}.`,
    `Right now: ${String(ctx?.now || '').slice(0, 300)}`,
    'Be quick and natural; the audience hears "say". Use web search when the host asks for facts, news, or something to find online, and name sources briefly in "show". Never invent URLs: only use links you found or YouTube search links. If you can’t do something, say so in "say".',
  ].join('\n');
}
function parseProducer(text) {
  const t = String(text || '').trim();
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i >= 0 && j > i) {
    try {
      const o = JSON.parse(t.slice(i, j + 1));
      return { say: String(o.say || '').slice(0, 600), show: String(o.show || '').slice(0, 4000), actions: Array.isArray(o.actions) ? o.actions.slice(0, 6) : [] };
    } catch {}
  }
  return { say: t.slice(0, 600), show: '', actions: [] };
}
async function producer({ provider, apiKey, model, messages, ctx }) {
  const p = PROVIDERS[provider];
  if (!p) throw new AIError(400, 'Choose Claude, ChatGPT, Gemini or Grok in the AI panel.');
  if (!apiKey || String(apiKey).length < 10) throw new AIError(400, `Add your ${p.label} API key in the AI panel.`);
  const msgs = cleanMessages(messages);
  const useModel = String(model || p.model).trim().slice(0, 80);
  const system = producerPrompt(ctx);
  let text = '';
  if (provider === 'claude') {
    const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 90_000 });
    let conv = msgs.map((m) => ({ role: m.role, content: m.text }));
    try {
      for (let turn = 0; turn < 4; turn++) {
        const res = await client.beta.messages.create({
          model: useModel, max_tokens: 16000, system,
          output_config: { effort: 'low' },
          tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
          betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
          messages: conv,
        });
        if (res.stop_reason === 'refusal') return { say: 'I can’t help with that one.', show: '', actions: [] };
        text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        if (res.stop_reason !== 'pause_turn') break;
        conv = [...conv, { role: 'assistant', content: res.content }];
      }
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new AIError(401, 'Claude rejected the API key. Check it in the AI panel.');
      if (e instanceof Anthropic.RateLimitError) throw new AIError(429, 'Claude is rate limiting this key. Try again in a moment.');
      if (e instanceof Anthropic.APIError) throw new AIError(502, `Claude error ${e.status}: ${e.message}`);
      throw e;
    }
  } else if (provider === 'gemini') {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(useModel)}:generateContent`, {
      method: 'POST', headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: msgs.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] })), tools: [{ google_search: {} }] }),
    });
    if (!res.ok) throw await providerError(res, 'Gemini', useModel);
    text = ((await res.json())?.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join('');
  } else {
    const base = provider === 'grok' ? 'https://api.x.ai/v1' : 'https://api.openai.com/v1';
    const res = await fetch(base + '/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: useModel, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, ...msgs.map((m) => ({ role: m.role, content: m.text }))] }),
    });
    if (!res.ok) throw await providerError(res, p.label, useModel);
    text = (await res.json())?.choices?.[0]?.message?.content || '';
  }
  return parseProducer(text);
}

// ---- voice: OpenAI text-to-speech, so the producer is heard in the stream --------------------------------
async function speech({ apiKey, text, voice }) {
  if (!apiKey || String(apiKey).length < 10) throw new AIError(400, 'Add a ChatGPT (OpenAI) key in the AI panel to give your producer a stream voice.');
  const input = String(text || '').slice(0, 1500);
  if (!input.trim()) throw new AIError(400, 'Nothing to say.');
  const v = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'].includes(voice) ? voice : 'alloy';
  for (const model of ['gpt-4o-mini-tts', 'tts-1']) {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, voice: v, input, response_format: 'mp3' }),
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    if (res.status !== 400 && res.status !== 404) throw await providerError(res, 'OpenAI voice', model);
  }
  throw new AIError(502, 'OpenAI couldn’t make speech for that.');
}

/** Shared HTTP handler for Vercel (api/ai.js) and server.js. Streams text/plain. */
async function handleAI(req, res, body) {
  if (body?.mode === 'agent' || body?.mode === 'tts') {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (body.mode === 'agent') { const out = await producer(body); res.statusCode = 200; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(out)); }
      else { const buf = await speech(body); res.statusCode = 200; res.setHeader('Content-Type', 'audio/mpeg'); res.end(buf); }
    } catch (e) {
      res.statusCode = e.status || 500; res.setHeader('Content-Type', 'application/json');
      if (!(e instanceof AIError)) console.error('[gather ai ' + body.mode + ']', e);
      res.end(JSON.stringify({ error: e instanceof AIError ? e.message : 'The AI request failed. Try again.' }));
    }
    return;
  }
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
