// The studio assistant's server side (lib/ai.js), against a local stand-in for the Claude API: the reply streams
// as text events, tool calls become studio actions, invalid tool input is refused, and the loop continues after
// a tool result. Also checks the JSON reply path used for ChatGPT, Gemini and Grok.
const http = require('node:http');

const calls = [];
function sse(res, events) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.end();
}
const msg = (id) => ({ message: { id, type: 'message', role: 'assistant', model: 'claude-test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
const text = (i, t) => [['content_block_start', { index: i, content_block: { type: 'text', text: '' } }], ['content_block_delta', { index: i, delta: { type: 'text_delta', text: t } }], ['content_block_stop', { index: i }]];
const tool = (i, id, name, input) => [['content_block_start', { index: i, content_block: { type: 'tool_use', id, name, input: {} } }], ['content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }], ['content_block_stop', { index: i }]];
const end = (reason) => [['message_delta', { delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 20 } }], ['message_stop', {}]];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const j = JSON.parse(body || '{}');
    calls.push({ url: req.url, key: req.headers['x-api-key'] || req.headers.authorization, body: j });
    const last = j.messages[j.messages.length - 1];
    if (Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
      return sse(res, [['message_start', msg('m2')], ...text(0, 'Done: Solo is up and the banner is showing.'), ...end('end_turn')]);
    }
    return sse(res, [['message_start', msg('m1')], ...text(0, 'On it.'),
      ...tool(1, 'tu1', 'switch_scene', { name: 'Solo' }),
      ...tool(2, 'tu2', 'show_banner', { text: 'Q&A time', sub: 'Ask in chat' }),
      ...tool(3, 'tu3', 'open_page', { url: 'javascript:alert(1)', label: 'bad' }),
      ...end('tool_use')]);
  });
});

server.listen(0, async () => {
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  const { agentStream, parseJsonReply } = require('../lib/ai');
  const events = [];
  let ok = true;
  const check = (name, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!cond) ok = false; };
  try {
    await agentStream({ provider: 'claude', apiKey: 'sk-ant-test-0123456789', messages: [{ role: 'user', text: 'Switch to solo and show a Q&A banner' }], ctx: { name: 'Sam', scenes: ['Solo', 'Interview'], library: [], now: 'scene: Interview' } }, (e) => events.push(e));
  } catch (e) { check('agent stream runs', false, e.message); }
  const textOut = events.filter((e) => e.t === 'text').map((e) => e.d).join('');
  const acts = events.filter((e) => e.t === 'action').map((e) => e.a);
  check('reply streams as text events, turns separated', textOut === 'On it.\n\nDone: Solo is up and the banner is showing.', JSON.stringify(textOut));
  check('tool calls become studio actions', JSON.stringify(acts) === JSON.stringify([{ type: 'scene', name: 'Solo' }, { type: 'banner', text: 'Q&A time', sub: 'Ask in chat' }]), JSON.stringify(acts));
  check('a non-https link is refused', !acts.some((a) => a.type === 'open'));
  check('loop continued after the tool results (2 calls)', calls.length === 2, String(calls.length));
  const results = calls[1]?.body.messages.at(-1).content || [];
  check('tool results sent back, bad input flagged as an error', results.length === 3 && results[2].is_error === true && !results[0].is_error, JSON.stringify(results.map((r) => r.is_error)));
  const first = calls[0]?.body || {};
  check('the host key is used and never sent elsewhere', calls.every((c) => /^(Bearer )?sk-ant-test-0123456789$/.test(c.key || '')), JSON.stringify(calls.map((c) => c.key)));
  check('web search and the seven studio tools are offered', first.tools?.some((t) => t.type === 'web_search_20260209') && first.tools.filter((t) => t.input_schema).length === 7);
  check('the prompt lists the scenes', /Scenes: Solo, Interview/.test(first.system || ''));
  const j = parseJsonReply('Sure! {"reply":"Switching now.","actions":[{"type":"scene","name":"Solo"},{"type":"open","url":"http://x.com"},{"type":"countdown","minutes":500},{"type":"nope"}]}');
  check('JSON replies (ChatGPT, Gemini, Grok) keep only valid actions', j.reply === 'Switching now.' && JSON.stringify(j.actions) === '[{"type":"scene","name":"Solo"}]', JSON.stringify(j));
  console.log(ok ? 'all AI checks passed' : 'FAIL an AI check did not hold');
  console.log('errors A', [], 'B', []);
  server.close();
  process.exit(ok ? 0 : 1);
});
