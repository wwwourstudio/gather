// gather — the studio assistant: answers questions and runs the studio, plus AI thumbnails and the stream voice.
// Uses the provider the host chose, with the host's own API key.
// Keys arrive with each request and are never stored or logged here.
const Anthropic = require('@anthropic-ai/sdk');
const { store } = require('./store');

const PROVIDERS = {
  claude: { label: 'Claude', model: 'claude-opus-5-5' },
  openai: { label: 'ChatGPT', model: 'gpt-5.5' },
  gemini: { label: 'Gemini', model: 'gemini-2.5-flash' },
  grok: { label: 'Grok', model: 'grok-4.7' },
};

class AIError extends Error { constructor(status, message) { super(message); this.status = status; } }

// ---- house allowance: the assistant works for hosts without their own key ---------------------------------------
// The site owner can set HOUSE_AI_PROVIDER (claude, openai, gemini or grok) + HOUSE_AI_KEY. Each studio then gets
// HOUSE_AI_DAILY assistant requests a day (default 25), and each network address three studios' worth, so a stray
// script can't run up the owner's bill. Hosts with their own key never touch it.
const HOUSE = { provider: String(process.env.HOUSE_AI_PROVIDER || '').trim().toLowerCase(), key: process.env.HOUSE_AI_KEY, model: process.env.HOUSE_AI_MODEL || '', daily: Math.max(1, Number(process.env.HOUSE_AI_DAILY) || 25) };
function houseInfo() { return HOUSE.key && PROVIDERS[HOUSE.provider] ? { provider: HOUSE.provider, daily: HOUSE.daily } : null; }
function clientIp(req) { return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown'; }
/** Count one house request; returns how many the studio has left today, or throws 429. */
async function spendHouse(req, studio) {
  const day = new Date().toISOString().slice(0, 10);
  const code = String(studio || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32);
  if (!code) throw new AIError(400, 'Enter a studio to use the free AI allowance.');
  const ks = `ai:house:s:${code}:${day}`, ki = `ai:house:ip:${clientIp(req)}:${day}`;
  const [ns, , ni] = await store.pipe([['INCR', ks], ['EXPIRE', ks, 90000], ['INCR', ki], ['EXPIRE', ki, 90000]]);
  if (Number(ns) > HOUSE.daily || Number(ni) > HOUSE.daily * 3) throw new AIError(429, `That’s today’s free AI allowance used up (${HOUSE.daily} requests). Add your own key in the AI settings to keep going, or come back tomorrow.`);
  return HOUSE.daily - Number(ns);
}

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

async function providerError(res, label, model) {
  let detail = '';
  try { const j = await res.json(); detail = j?.error?.message || j?.message || ''; } catch {}
  if (res.status === 401 || res.status === 403) return new AIError(401, `${label} rejected the API key. Check it in the AI panel.`);
  if (res.status === 404) return new AIError(400, `${label} does not recognise the model "${model}". ${detail}`.trim());
  if (res.status === 429) return new AIError(429, `${label} is rate limiting this key, or the account is out of credit. ${detail}`.trim());
  return new AIError(502, `${label} error ${res.status}. ${detail}`.trim());
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

// ---- the assistant: one conversation that answers questions and runs the studio --------------------------
// Streams newline-delimited JSON events: {t:'text',d} as the reply is written, {t:'action',a} for each studio
// action, then {t:'done'} (or {t:'error',message}). Claude gets real tools plus web search; ChatGPT, Gemini and
// Grok reply with one JSON object that is mapped onto the same events.
const ACTIONS = {
  open_page: { type: 'open', description: 'Pull up a web page or video for the host to put on screen. For YouTube use a direct https://www.youtube.com/watch?v=… link you found, otherwise a YouTube search link https://www.youtube.com/results?search_query=…', props: { url: { type: 'string', description: 'https URL you found or a YouTube search URL. Never invent one.' }, label: { type: 'string', description: 'Short title, a few words' } }, required: ['url'] },
  switch_scene: { type: 'scene', description: 'Switch the stage to one of the studio’s scenes.', props: { name: { type: 'string', description: 'Exact scene name from the list' } }, required: ['name'] },
  present_media: { type: 'present', description: 'Put a file from the media library on screen.', props: { name: { type: 'string', description: 'Exact library item name' } }, required: ['name'] },
  stop_presenting: { type: 'stop', description: 'Stop whatever is being presented.', props: {}, required: [] },
  show_banner: { type: 'banner', description: 'Show a lower-third headline banner.', props: { text: { type: 'string', description: 'Headline, under 60 characters' }, sub: { type: 'string', description: 'Optional second line' } }, required: ['text'] },
  hide_banner: { type: 'hide_banner', description: 'Hide the banner.', props: {}, required: [] },
  start_countdown: { type: 'countdown', description: 'Start an on-stage countdown.', props: { minutes: { type: 'number', description: '1 to 120' } }, required: ['minutes'] },
};
/** Check a model-supplied action against its schema; returns the studio action or null. */
function cleanAction(type, input) {
  const a = { type };
  const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
  if (type === 'open') { const url = str(input?.url, 600); if (!url || !/^https:\/\//i.test(url)) return null; a.url = url; a.label = str(input?.label, 80) || ''; }
  else if (type === 'scene' || type === 'present') { a.name = str(input?.name, 80); if (!a.name) return null; }
  else if (type === 'banner') { a.text = str(input?.text, 120); if (!a.text) return null; a.sub = str(input?.sub, 120) || ''; }
  else if (type === 'countdown') { const m = Number(input?.minutes); if (!(m >= 1 && m <= 120)) return null; a.minutes = Math.round(m); }
  else if (!['stop', 'hide_banner'].includes(type)) return null;
  return a;
}

function agentPrompt(ctx, json) {
  const name = String(ctx?.name || 'Sam').slice(0, 24);
  const scenes = (ctx?.scenes || []).slice(0, 40).map((x) => String(x).slice(0, 40));
  const library = (ctx?.library || []).slice(0, 40).map((x) => `${String(x?.name).slice(0, 50)} (${String(x?.kind).slice(0, 10)})`);
  const lines = [
    `You are ${name}, the producer and researcher for a live show in a browser studio called gather. The host talks or types to you during the show, like a producer in the booth.`,
    'Two kinds of request:',
    '- A question (facts, news, an explainer, a stat): answer it. Your reply is shown on screen to a live audience and its first sentence may be read aloud, so lead with the answer in one plain sentence, then at most a few short lines or bullets. Under about 90 words. No headings, tables or code. Name sources briefly in plain words ("per Reuters, March 2026"). If unsure, say so.',
    '- Something to do in the studio (switch scene, present a file, show a banner, a countdown, find a video or site): do it, then confirm in one short sentence.',
    'Look things up on the web whenever facts could have changed or the host asks you to find something. Never invent URLs.',
    `Scenes: ${scenes.length ? scenes.join(', ') : 'none listed'}.`,
    `Media library: ${library.length ? library.join(', ') : 'empty'}.`,
    `Right now: ${String(ctx?.now || '').slice(0, 300)}`,
  ];
  if (json) {
    lines.push('Reply with ONE JSON object and nothing else: {"reply": "your reply text", "actions": [ ... ]}. Actions (use only these):');
    for (const a of Object.values(ACTIONS)) lines.push(`{"type":"${a.type}"${Object.keys(a.props).map((k) => `,"${k}":…`).join('')}}: ${a.description}`);
  }
  return lines.join('\n');
}
function parseJsonReply(text) {
  const t = String(text || '').trim();
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i >= 0 && j > i) {
    try {
      const o = JSON.parse(t.slice(i, j + 1));
      const reply = String(o.reply ?? [o.say, o.show].filter(Boolean).join('\n\n')).slice(0, 4000);
      const actions = (Array.isArray(o.actions) ? o.actions : []).slice(0, 6).map((a) => cleanAction(String(a?.type || ''), a)).filter(Boolean);
      return { reply, actions };
    } catch {}
  }
  return { reply: t.slice(0, 4000), actions: [] };
}

async function agentStream({ provider, apiKey, model, messages, ctx }, emit) {
  const p = PROVIDERS[provider];
  if (!p) throw new AIError(400, 'Choose Claude, ChatGPT, Gemini or Grok in the AI panel.');
  if (!apiKey || String(apiKey).length < 10) throw new AIError(400, `Add your ${p.label} API key in the AI panel.`);
  const msgs = cleanMessages(messages);
  const useModel = String(model || p.model).trim().slice(0, 80);
  if (provider === 'claude') return agentClaude(apiKey, useModel, msgs, ctx, emit);
  const system = agentPrompt(ctx, true);
  let text = '';
  if (provider === 'gemini') {
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
  const out = parseJsonReply(text);
  if (out.reply) emit({ t: 'text', d: out.reply });
  for (const a of out.actions) emit({ t: 'action', a });
}

async function agentClaude(apiKey, model, msgs, ctx, emit) {
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 120_000 });
  const tools = [
    { type: 'web_search_20260209', name: 'web_search', max_uses: 4 },
    ...Object.entries(ACTIONS).map(([name, a]) => ({ name, description: a.description, eager_input_streaming: true, input_schema: { type: 'object', properties: a.props, required: a.required } })),
  ];
  let messages = msgs.map((m) => ({ role: m.role, content: m.text }));
  let jsonRetries = 0, wrote = false;
  try {
    for (let turn = 0; turn < 6; turn++) {
      const stream = client.beta.messages.stream({
        model, max_tokens: 16000, system: agentPrompt(ctx, false),
        output_config: { effort: 'low' },
        tools, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
        messages,
      });
      // Separate the text of successive turns (before and after a tool call) with a paragraph break.
      let first = true;
      stream.on('text', (t) => { if (first && wrote) emit({ t: 'text', d: '\n\n' }); first = false; wrote = true; emit({ t: 'text', d: t }); });
      let msg;
      try { msg = await stream.finalMessage(); jsonRetries = 0; }
      catch (e) { if (e instanceof Anthropic.APIError || jsonRetries++ >= 2) throw e; continue; } // unparseable tool input: re-issue the turn
      if (msg.stop_reason === 'refusal') { emit({ t: 'text', d: (wrote ? '\n\n' : '') + 'I can’t help with that one.' }); return; }
      if (msg.stop_reason === 'pause_turn') { messages = [...messages, { role: 'assistant', content: msg.content }]; continue; }
      const uses = msg.content.filter((b) => b.type === 'tool_use');
      if (!uses.length || msg.stop_reason !== 'tool_use') return; // end_turn, or max_tokens with no tool to run
      const results = uses.map((u) => {
        const def = ACTIONS[u.name];
        const a = def ? cleanAction(def.type, u.input) : null;
        if (a) emit({ t: 'action', a });
        return { type: 'tool_result', tool_use_id: u.id, content: a ? 'Done. It is happening in the studio now.' : 'That input was not valid; nothing happened.', is_error: !a };
      });
      messages = [...messages, { role: 'assistant', content: msg.content }, { role: 'user', content: results }];
    }
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new AIError(401, 'Claude rejected the API key. Check it in the AI panel.');
    if (e instanceof Anthropic.NotFoundError) throw new AIError(400, `Claude does not recognise the model "${model}".`);
    if (e instanceof Anthropic.RateLimitError) throw new AIError(429, 'Claude is rate limiting this key. Try again in a moment.');
    if (e instanceof Anthropic.APIError) throw new AIError(502, `Claude error ${e.status}: ${e.message}`);
    throw e;
  }
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

/** Shared HTTP handler for Vercel (api/ai.js) and server.js. */
async function handleAI(req, res, body) {
  if (body?.mode === 'agent' || body?.mode === 'tts') {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (body.mode === 'agent') {
        if (body.house) {
          if (!houseInfo()) throw new AIError(400, 'Add your own API key in the AI settings.');
          res.setHeader('X-AI-Left', String(await spendHouse(req, body.studio)));
          body = { ...body, provider: HOUSE.provider, apiKey: HOUSE.key, model: HOUSE.model };
        }
        // NDJSON stream. Errors before the first event get a real status; later ones arrive as an error event.
        let started = false;
        const emit = (ev) => { if (!started) { started = true; res.statusCode = 200; res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8'); res.setHeader('X-Accel-Buffering', 'no'); } res.write(JSON.stringify(ev) + '\n'); };
        try { await agentStream(body, emit); emit({ t: 'done' }); res.end(); }
        catch (e) {
          if (!started) throw e;
          if (!(e instanceof AIError)) console.error('[gather ai agent]', e);
          emit({ t: 'error', message: e instanceof AIError ? e.message : 'The AI request failed. Try again.' }); res.end();
        }
        return;
      }
      const buf = await speech(body); res.statusCode = 200; res.setHeader('Content-Type', 'audio/mpeg'); res.end(buf);
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
  res.statusCode = 400; res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'Unknown AI request.' }));
}

module.exports = { handleAI, agentStream, parseJsonReply, cleanAction, houseInfo, PROVIDERS };
