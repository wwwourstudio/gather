/**
 * Monte Carlo over gather's next steps and the services that could power them.
 *
 *   node scripts/roadmap-mc.ts [samples]      # prints the ranking, writes ROADMAP-MC.md and audit/roadmap-mc.json
 *
 * Every option has uncertain inputs, drawn per sample from triangular distributions (low, likely, high):
 *   reach    share of hosts or guests the problem actually hits (0–1)
 *   impact   how bad it is for them when it hits (0–10; 10 = "can't use gather for this at all")
 *   success  chance the option works as planned in production (0–1; drawn as a Bernoulli per sample)
 *   effort   build days, including tests
 *   cost     USD per month at a modest scale (≈20 shows a month, 1 h each, 3–4 people, 6 Mbit/s to platforms)
 * Score per sample = value delivered per build day, where value = reach × impact × (worked ? 1 : 0.1) − cost / 20
 * (gather's goal is "free", so $20 a month costs as much as a problem that hits every user at impact 1).
 * Options in the same group are alternatives (only one relay is needed); the sampler reports how often each one
 * wins its group, then fills a 10-day budget greedily with group winners and reports how often each step makes
 * the cut. Inputs come from the providers' published prices where found (sources in ROADMAP-MC.md); the ranges
 * are wide where they weren't.
 */
const fs = require('node:fs') as typeof import('node:fs');
const path = require('node:path') as typeof import('node:path');

type Tri = [number, number, number];
interface Option {
  id: string; group: string; name: string; service: string;
  reach: Tri; impact: Tri; success: Tri; effort: Tri; cost: Tri;
  needs: string; note: string;
}

const OPTIONS: Option[] = [
  // ---- guests who can't connect (strict NAT, corporate and some mobile networks)
  { id: 'turn-cloudflare', group: 'Connectivity (TURN relay)', name: 'Built-in TURN', service: 'Cloudflare Realtime TURN', reach: [0.06, 0.12, 0.22], impact: [8, 9.5, 10], success: [0.88, 0.95, 0.99], effort: [0.5, 1, 1.5], cost: [0, 0, 2], needs: 'Free Cloudflare account; TURN key ID + API token in Vercel', note: '$0.05/GB after 1,000 GB/month free (shared with the SFU).' },
  { id: 'turn-metered', group: 'Connectivity (TURN relay)', name: 'Built-in TURN', service: 'Metered.ca TURN', reach: [0.06, 0.12, 0.22], impact: [8, 9.5, 10], success: [0.8, 0.9, 0.97], effort: [0.5, 1, 1.5], cost: [0, 5, 30], needs: 'Metered account + API key', note: 'Small free allowance, then paid per GB; price not verified here.' },
  { id: 'turn-self', group: 'Connectivity (TURN relay)', name: 'Built-in TURN', service: 'Self-hosted coturn (VM)', reach: [0.06, 0.12, 0.22], impact: [8, 9.5, 10], success: [0.6, 0.75, 0.9], effort: [1.5, 2.5, 4], cost: [4, 6, 15], needs: 'A VM with public UDP ports', note: 'You run and patch a server.' },
  // ---- going live on YouTube / Twitch / Kick (platforms only take RTMP(S); browsers can't send it)
  { id: 'live-ws-ffmpeg', group: 'Go live (RTMP relay)', name: 'Go live to platforms', service: 'gather relay: WebSocket + FFmpeg on Fly.io', reach: [0.55, 0.75, 0.92], impact: [8, 9, 10], success: [0.72, 0.85, 0.93], effort: [2, 3, 4.5], cost: [2, 5, 12], needs: 'Fly.io account (or any Docker host); RELAY_URL + RELAY_SECRET in Vercel', note: 'Browser sends the finished program (H.264 where the browser can) over WSS; FFmpeg copies video and pushes to every destination at once.' },
  { id: 'live-mediamtx', group: 'Go live (RTMP relay)', name: 'Go live to platforms', service: 'MediaMTX (WHIP in, RTMP out) on Fly.io', reach: [0.55, 0.75, 0.92], impact: [8, 9, 10], success: [0.5, 0.68, 0.82], effort: [2.5, 4, 6], cost: [4, 7, 14], needs: 'Fly.io account + dedicated IPv4 + UDP', note: 'Lower latency, but WebRTC on a PaaS needs UDP/ICE work; per-destination FFmpeg still needed for multistreaming.' },
  { id: 'live-livekit', group: 'Go live (RTMP relay)', name: 'Go live to platforms', service: 'LiveKit Cloud (egress to RTMP)', reach: [0.55, 0.75, 0.92], impact: [8, 9, 10], success: [0.65, 0.78, 0.88], effort: [6, 9, 13], cost: [0, 25, 90], needs: 'LiveKit Cloud account; rebuild calls on the LiveKit SDK', note: 'Also brings an SFU and TURN, but means rewriting the call layer; egress beyond the free allowance is paid.' },
  { id: 'live-cf-stream', group: 'Go live (RTMP relay)', name: 'Go live to platforms', service: 'Cloudflare Stream (WHIP in, simulcast out)', reach: [0.55, 0.75, 0.92], impact: [8, 9, 10], success: [0.02, 0.05, 0.12], effort: [1.5, 2.5, 4], cost: [3, 8, 20], needs: 'Cloudflare Stream subscription', note: 'Cloudflare documents that WHIP (browser) inputs cannot be restreamed, so this fails without a relay anyway.' },
  // ---- 4+ people in a studio (mesh: every sender uploads one copy per participant)
  { id: 'sfu-cloudflare', group: 'Bigger studios (SFU)', name: 'Scale to 6–10 people', service: 'Cloudflare Realtime SFU', reach: [0.15, 0.3, 0.45], impact: [4, 6, 8], success: [0.55, 0.7, 0.85], effort: [6, 8, 12], cost: [0, 0, 5], needs: 'Cloudflare Realtime app ID + token', note: 'Free within the shared 1,000 GB; low-level sessions/tracks API, so a large client rewrite.' },
  { id: 'sfu-livekit', group: 'Bigger studios (SFU)', name: 'Scale to 6–10 people', service: 'LiveKit Cloud SFU', reach: [0.15, 0.3, 0.45], impact: [4, 6, 8], success: [0.65, 0.78, 0.9], effort: [5, 7, 10], cost: [0, 10, 50], needs: 'LiveKit Cloud account', note: 'Mature SDK; usage beyond the free plan is paid.' },
  // ---- getting started
  { id: 'onboarding', group: 'First run', name: 'First-run guide (name, camera check, invite, go live)', service: 'In-app', reach: [0.7, 0.9, 1], impact: [3, 4.5, 6], success: [0.85, 0.93, 0.98], effort: [0.5, 1, 1.5], cost: [0, 0, 0], needs: 'Nothing', note: 'Cuts the dense first screen down to the next step.' },
  { id: 'ai-house', group: 'AI without a key', name: 'AI works without your own key (daily allowance)', service: 'House key on the server (Gemini or Claude), rate-limited', reach: [0.5, 0.7, 0.85], impact: [3, 4.5, 6], success: [0.75, 0.85, 0.95], effort: [0.5, 1, 1.5], cost: [0, 5, 40], needs: 'A provider key in Vercel (owner pays or uses a free tier)', note: 'Costs whoever owns the key; capped per studio per day.' },
  // ---- the rest
  { id: 'iso-tracks', group: 'Recording', name: 'Separate high-quality track per guest (to Drive)', service: 'In-browser recording + Google Drive', reach: [0.15, 0.3, 0.45], impact: [3, 5, 7], success: [0.7, 0.8, 0.9], effort: [3, 4, 6], cost: [0, 0, 0], needs: 'GOOGLE_CLIENT_ID (already supported)', note: 'Paid on StreamYard.' },
  { id: 'realtime-signal', group: 'Signaling', name: 'Real-time signaling instead of polling', service: 'Cloudflare Durable Objects WebSockets', reach: [0.8, 1, 1], impact: [1.5, 2.5, 4], success: [0.6, 0.75, 0.88], effort: [3, 4, 6], cost: [0, 5, 5], needs: 'Cloudflare Workers paid plan ($5)', note: 'Faster joins and fewer Vercel invocations.' },
  { id: 'watch-page', group: 'Audience', name: 'Public watch page', service: 'Embed of the YouTube/Twitch stream', reach: [0.25, 0.45, 0.6], impact: [2, 3.5, 5], success: [0.75, 0.88, 0.95], effort: [1, 1.5, 2.5], cost: [0, 0, 0], needs: 'Go live first', note: 'Only useful once going live works.' },
];
const DEPENDS: Record<string, string> = { 'watch-page': 'Go live (RTMP relay)' };

let seed = 20261115;
const rnd = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const tri = ([a, c, b]: Tri): number => { if (a === b) return a; const u = rnd(), f = (c - a) / (b - a); return u < f ? a + Math.sqrt(u * (b - a) * (c - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - c)); };

function main(): void {
  const N = Number(process.argv[2]) || 20000, BUDGET = 10;
  const wins: Record<string, number> = {}, picked: Record<string, number> = {}, scoreSum: Record<string, number> = {}, order: Record<string, number> = {};
  const groups = [...new Set(OPTIONS.map((o) => o.group))];
  for (let n = 0; n < N; n++) {
    const s = OPTIONS.map((o) => {
      const worked = rnd() < tri(o.success);
      const value = tri(o.reach) * tri(o.impact) * (worked ? 1 : 0.1) - tri(o.cost) / 20;
      const effort = tri(o.effort);
      return { o, value, effort, score: value / effort };
    });
    for (const x of s) scoreSum[x.o.id] = (scoreSum[x.o.id] || 0) + x.score;
    const best = groups.map((g) => s.filter((x) => x.o.group === g).sort((a, b) => b.score - a.score)[0]);
    for (const b of best) wins[b.o.id] = (wins[b.o.id] || 0) + 1;
    // fill a 10-day budget, best value per day first, respecting dependencies
    let days = 0, rank = 0;
    const done = new Set<string>();
    for (const b of [...best].sort((a, b2) => b2.score - a.score)) {
      if (b.value <= 0 || days + b.effort > BUDGET) continue;
      const dep = DEPENDS[b.o.id]; if (dep && !done.has(dep)) continue;
      days += b.effort; done.add(b.o.group); rank++;
      picked[b.o.id] = (picked[b.o.id] || 0) + 1; order[b.o.id] = (order[b.o.id] || 0) + rank;
    }
  }
  const pct = (x = 0): string => `${Math.round((x / N) * 100)}%`;
  const rows = OPTIONS.map((o) => ({ o, win: wins[o.id] || 0, pick: picked[o.id] || 0, mean: (scoreSum[o.id] || 0) / N, pos: picked[o.id] ? order[o.id] / picked[o.id] : 99 }));
  const lines: string[] = [];
  lines.push('# Roadmap Monte Carlo', '', `${N.toLocaleString()} simulated futures, seed 20261115, 10-day build budget. Re-run with \`node scripts/roadmap-mc.ts\`.`, '');
  lines.push('## Which service wins each job', '', '| Job | Option | Wins its job | Mean value per build day |', '|---|---|---|---|');
  for (const g of groups) for (const r of rows.filter((x) => x.o.group === g).sort((a, b) => b.win - a.win)) lines.push(`| ${g} | ${r.o.service} | ${pct(r.win)} | ${r.mean.toFixed(2)} |`);
  lines.push('', '## What makes a 10-day plan', '', '| Step | Service | In the plan | Usual order | Needs |', '|---|---|---|---|---|');
  for (const r of rows.filter((x) => x.pick / N >= 0.05).sort((a, b) => b.pick - a.pick || a.pos - b.pos)) lines.push(`| ${r.o.name} | ${r.o.service} | ${pct(r.pick)} | ${r.pos.toFixed(1)} | ${r.o.needs} |`);
  lines.push('', '## Assumptions', '');
  for (const o of OPTIONS) lines.push(`- **${o.service}** (${o.name}): reach ${o.reach.join('–')}, impact ${o.impact.join('–')}, works ${o.success.join('–')}, ${o.effort.join('–')} days, $${o.cost.join('–')}/month. ${o.note}`);
  lines.push('', '## Sources', '',
    '- Cloudflare TURN pricing and free allowance: https://developers.cloudflare.com/realtime/turn/faq/ and https://developers.cloudflare.com/realtime/sfu/pricing',
    '- Cloudflare Stream WebRTC limits (no restreaming for WHIP inputs): https://developers.cloudflare.com/stream/webrtc/ and https://developers.cloudflare.com/changelog/post/2026-10-15-stream-live-webrtc-ga/',
    '- Cloudflare Stream simulcasting: https://developers.cloudflare.com/stream/stream-live/simulcasting',
    '- Cloudflare Stream pricing: https://developers.cloudflare.com/stream/pricing',
    '- LiveKit Cloud pricing and quotas: https://livekit.io/pricing and https://docs.livekit.io/deploy/admin/quotas-and-limits/',
    '- YouTube/Twitch ingest is RTMP(S)/HLS only, so a browser needs a relay: https://www.forasoft.com/blog/article/whip-whep-replace-rtmp-live-streaming-2026',
    '- Fly.io, Metered and Durable Objects costs are estimates (not verified in this session); their ranges are wide.');
  const md = lines.join('\n') + '\n';
  fs.writeFileSync(path.resolve(__dirname, '..', 'ROADMAP-MC.md'), md);
  fs.mkdirSync(path.resolve(__dirname, '..', 'audit'), { recursive: true });
  fs.writeFileSync(path.resolve(__dirname, '..', 'audit', 'roadmap-mc.json'), JSON.stringify({ samples: N, rows: rows.map((r) => ({ id: r.o.id, service: r.o.service, wins: r.win / N, inPlan: r.pick / N, meanScore: r.mean, order: r.pos })) }, null, 2));
  console.log(md);
}
main();
