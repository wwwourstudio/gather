// The public watch page (/w/<studio>): while the host is live, the platform player plus links to every platform
// the show is on. Reads only the studio's public watch info; checks again every 15 seconds.
const $ = (s) => document.querySelector(s);
const code = decodeURIComponent(location.pathname.split('/')[2] || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
const NAMES = { youtube: 'YouTube', twitch: 'Twitch', kick: 'Kick', facebook: 'Facebook', x: 'X', rumble: 'Rumble', custom: 'Watch' };
let since = 0, shown = '';
const HOSTS = { 'youtube.com': 'YouTube', 'youtu.be': 'YouTube', 'twitch.tv': 'Twitch', 'kick.com': 'Kick', 'facebook.com': 'Facebook', 'x.com': 'X', 'twitter.com': 'X', 'rumble.com': 'Rumble' };
/** The platform's name, from the link itself when the host added it as a custom destination. */
function nameOf(l) { try { const h = new URL(l.url).hostname.replace(/^www\.|^m\./, ''); return HOSTS[h] || NAMES[l.kind] || h; } catch { return NAMES[l.kind] || 'Watch'; } }

/** An embeddable player address for a public watch link, or '' when the platform has no embed we can build. */
export function embedFor(kind, raw, host = location.hostname) {
  let u; try { u = new URL(raw); } catch { return ''; }
  const h = u.hostname.replace(/^www\.|^m\./, '');
  if (h === 'twitch.tv') { const ch = u.pathname.split('/')[1]; return /^[a-z0-9_]{2,25}$/i.test(ch || '') ? `https://player.twitch.tv/?channel=${ch}&parent=${host}&muted=true` : ''; }
  if (h === 'kick.com') { const ch = u.pathname.split('/')[1]; return /^[a-z0-9_-]{2,30}$/i.test(ch || '') ? `https://player.kick.com/${ch}?muted=true` : ''; }
  if (h === 'youtu.be') { const id = u.pathname.slice(1); return /^[\w-]{11}$/.test(id) ? `https://www.youtube.com/embed/${id}?autoplay=1&mute=1` : ''; }
  if (h === 'youtube.com') {
    const v = u.searchParams.get('v') || (u.pathname.match(/^\/(?:live|embed|shorts)\/([\w-]{11})/) || [])[1];
    if (v && /^[\w-]{11}$/.test(v)) return `https://www.youtube.com/embed/${v}?autoplay=1&mute=1`;
    const ch = (u.pathname.match(/^\/channel\/(UC[\w-]{22})/) || [])[1];
    if (ch) return `https://www.youtube.com/embed/live_stream?channel=${ch}&autoplay=1&mute=1`;
  }
  return '';
}

function play(src) {
  if (shown === src) return;
  shown = src;
  const f = document.createElement('iframe');
  f.src = src; f.allow = 'autoplay; fullscreen; picture-in-picture; encrypted-media'; f.allowFullscreen = true; f.title = 'Live player';
  $('#wPlayer').replaceChildren(f);
}
function clock() {
  if (!since) return;
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  $('#wLiveText').textContent = 'Live · ' + [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n, i) => (i ? String(n).padStart(2, '0') : n)).join(':').replace(/^0:/, '');
}
function render(info) {
  const title = info.found ? info.title || 'Live show' : 'Show not found';
  $('#wTitle').textContent = title; document.title = `${title} · Watch live`;
  if (info.color) document.documentElement.style.setProperty('--accent', info.color);
  const live = info.found && info.live?.on, links = live ? info.live.links || [] : [];
  since = live ? info.live.since : 0; clock();
  $('#wLive').hidden = !live;
  const playable = links.map((l) => ({ ...l, embed: embedFor(l.kind, l.url) })).filter((l) => l.embed);
  if (!playable.some((l) => l.embed === shown)) shown = '';
  if (playable.length && !shown) play(playable[0].embed);
  $('#wPlayer').hidden = !playable.length;
  $('#wEmpty').hidden = !!playable.length;
  $('#wEmptyH').textContent = !info.found ? 'This studio isn’t open right now.' : !live ? 'Not live right now.' : 'Live now on the platforms below.';
  $('#wEmptyP').textContent = !info.found ? 'Check the link with the host.' : !live ? 'This page starts playing by itself when the show goes live.' : 'Pick a platform to watch.';
  $('#wTabs').hidden = playable.length < 2;
  $('#wTabs').replaceChildren(...playable.map((l) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn sm' + (l.embed === shown ? ' on' : ''); b.textContent = 'Watch on ' + nameOf(l); b.onclick = () => { play(l.embed); render(info); }; return b; }));
  $('#wLinks').replaceChildren(...links.map((l) => { const a = document.createElement('a'); a.className = 'btn'; a.href = l.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = `Open on ${nameOf(l)}`; return a; }));
}
async function check() {
  try {
    const r = await fetch('/api/studio?action=watch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ studio: code }) });
    render(r.ok ? await r.json() : { found: false });
  } catch { $('#wEmptyH').textContent = 'Can’t reach gather right now. Retrying…'; }
}
if (code) { check(); setInterval(check, 15000); setInterval(clock, 1000); } else render({ found: false });
