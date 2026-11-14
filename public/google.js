// Google sign-in for gather: save recordings to Google Drive, and read / moderate YouTube live chat.
// Uses Google Identity Services' token flow in the host's browser: access tokens live in this tab only
// (never sent to gather's server) and expire after an hour. Scopes are asked for when first needed:
//   drive.file  — gather can only see and write files it created (its "gather recordings" folder)
//   youtube     — read your live chat, remove messages and time out / ban viewers on your broadcasts
export const SCOPES = {
  drive: 'https://www.googleapis.com/auth/drive.file',
  youtube: 'https://www.googleapis.com/auth/youtube',
};
const API = 'https://www.googleapis.com';
let clientId = '', gis = null, tokenClient = null;
const auth = { token: '', exp: 0, scopes: new Set() };

export function configureGoogle(id) { clientId = String(id || ''); }
export const googleConfigured = () => !!clientId;
export const googleSignedIn = (key) => !!auth.token && Date.now() < auth.exp && (!key || auth.scopes.has(SCOPES[key]));

function loadGis() {
  gis ||= new Promise((res, rej) => {
    if (window.google?.accounts?.oauth2) return res(window.google.accounts.oauth2);
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = () => (window.google?.accounts?.oauth2 ? res(window.google.accounts.oauth2) : rej(new Error('Google sign-in did not load.')));
    s.onerror = () => { gis = null; rej(new Error('Could not reach Google sign-in. Check your connection or ad blocker.')); };
    document.head.append(s);
  });
  return gis;
}

/** An access token covering `keys` (e.g. ['drive']). Opens Google's consent popup when needed, so call from a click. */
export async function googleToken(keys) {
  if (!clientId) throw new Error('Google sign-in isn’t set up on this server yet (GOOGLE_CLIENT_ID).');
  const want = keys.map((k) => SCOPES[k]);
  if (auth.token && Date.now() < auth.exp - 60_000 && want.every((s) => auth.scopes.has(s))) return auth.token;
  const oauth = await loadGis();
  const scope = [...new Set([...auth.scopes, ...want])].join(' ');
  return new Promise((res, rej) => {
    tokenClient = oauth.initTokenClient({
      client_id: clientId, scope, include_granted_scopes: true,
      callback: (r) => {
        if (r.error) return rej(new Error(r.error === 'access_denied' ? 'Google access was not allowed.' : `Google sign-in failed: ${r.error_description || r.error}`));
        auth.token = r.access_token; auth.exp = Date.now() + (Number(r.expires_in) || 3600) * 1000;
        auth.scopes = new Set(String(r.scope || scope).split(' '));
        const missing = want.filter((s) => !auth.scopes.has(s));
        if (missing.length) return rej(new Error('Google sign-in finished without the permission gather needs. Try again and tick every box.'));
        res(auth.token);
      },
      error_callback: (e) => rej(new Error(e?.type === 'popup_closed' ? 'The Google sign-in window was closed.' : e?.type === 'popup_failed_to_open' ? 'Your browser blocked the Google sign-in window. Allow pop-ups for this site.' : 'Google sign-in failed.')),
    });
    tokenClient.requestAccessToken({ prompt: '' });
  });
}
export async function googleSignOut() {
  if (auth.token) { try { (await loadGis()).revoke(auth.token, () => {}); } catch {} }
  auth.token = ''; auth.exp = 0; auth.scopes = new Set();
}

async function gfetch(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${auth.token}`, ...(opts.headers || {}) } });
  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const reason = j?.error?.errors?.[0]?.reason || '';
    const msg = { quotaExceeded: 'YouTube’s daily API quota is used up. It resets at midnight Pacific time.', liveChatEnded: 'This live chat has ended.', forbidden: 'Google refused: your account isn’t the owner or a moderator here.', insufficientPermissions: 'gather needs more Google permission. Disconnect and connect again.' }[reason];
    const e = new Error(msg || j?.error?.message || `Google answered ${r.status}.`); e.status = r.status; e.reason = reason; throw e;
  }
  return j;
}

// ------------------------------------------------------------------ Drive
async function driveFolder() {
  const key = 'gather:driveFolder';
  const known = localStorage.getItem(key);
  if (known) {
    try { const f = await gfetch(`${API}/drive/v3/files/${encodeURIComponent(known)}?fields=id,trashed`); if (f && !f.trashed) return known; } catch {}
  }
  const f = await gfetch(`${API}/drive/v3/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'gather recordings', mimeType: 'application/vnd.google-apps.folder' }) });
  localStorage.setItem(key, f.id);
  return f.id;
}
const CHUNK = 8 * 1024 * 1024; // a multiple of 256 KiB, as Drive's resumable upload requires
function putChunk(session, blob, start, total, onProgress) {
  return new Promise((res, rej) => {
    const end = Math.min(start + CHUNK, total), x = new XMLHttpRequest();
    x.open('PUT', session);
    x.setRequestHeader('Content-Range', `bytes ${start}-${end - 1}/${total}`);
    x.upload.onprogress = (e) => onProgress(start + e.loaded);
    x.onload = () => {
      if (x.status === 200 || x.status === 201) return res({ done: true, file: JSON.parse(x.responseText || '{}') });
      if (x.status === 308) { const r = x.getResponseHeader('Range'); return res({ done: false, next: r ? Number(r.split('-')[1]) + 1 : end }); }
      const e = new Error(`Drive upload failed (${x.status}).`); e.status = x.status; rej(e);
    };
    x.onerror = () => rej(Object.assign(new Error('The connection dropped during upload.'), { status: 0 }));
    x.send(blob.slice(start, end));
  });
}
/** Ask Drive how much of an interrupted upload it already has. */
function uploadedSoFar(session, total) {
  return new Promise((res) => {
    const x = new XMLHttpRequest(); x.open('PUT', session); x.setRequestHeader('Content-Range', `bytes */${total}`);
    x.onload = () => { if (x.status === 308) { const r = x.getResponseHeader('Range'); res(r ? Number(r.split('-')[1]) + 1 : 0); } else res(x.status === 200 || x.status === 201 ? total : 0); };
    x.onerror = () => res(-1); x.send();
  });
}
/**
 * Upload a recording into the "gather recordings" folder with a resumable upload: 8 MB chunks, progress, and
 * automatic retries (a dropped connection picks up where it stopped). Returns { id, name, webViewLink }.
 */
export async function saveToDrive(blob, name, onProgress = () => {}) {
  await googleToken(['drive']);
  const folder = await driveFolder();
  const init = await fetch(`${API}/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': blob.type || 'video/webm', 'X-Upload-Content-Length': String(blob.size) },
    body: JSON.stringify({ name, parents: [folder], description: 'Recorded in gather' }),
  });
  if (!init.ok) { const j = await init.json().catch(() => ({})); throw new Error(j?.error?.message || `Drive refused the upload (${init.status}).`); }
  const session = init.headers.get('Location');
  if (!session) throw new Error('Drive did not start the upload.');
  let at = 0, tries = 0;
  for (;;) {
    try {
      const r = await putChunk(session, blob, at, blob.size, (n) => onProgress(Math.min(1, n / blob.size)));
      tries = 0;
      if (r.done) { onProgress(1); return r.file; }
      at = r.next;
    } catch (e) {
      if (++tries > 5 || (e.status >= 400 && e.status < 500)) throw e;
      await new Promise((res) => setTimeout(res, 1000 * 2 ** tries));
      const have = await uploadedSoFar(session, blob.size);
      if (have >= 0) at = have;
    }
  }
}

// ------------------------------------------------------------------ YouTube live chat
const videoIdOf = (s) => { const m = String(s || '').match(/(?:v=|youtu\.be\/|live\/|shorts\/)([\w-]{11})/) || String(s || '').match(/^([\w-]{11})$/); return m ? m[1] : ''; };
/** Your live broadcast's chat, or the chat of a video link you paste. Returns { liveChatId, title }. */
export async function findLiveChat(videoLink = '') {
  await googleToken(['youtube']);
  const id = videoIdOf(videoLink);
  if (id) {
    const v = await gfetch(`${API}/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${id}`);
    const it = v.items?.[0];
    if (!it?.liveStreamingDetails?.activeLiveChatId) throw new Error('That video has no live chat right now. Is it live?');
    return { liveChatId: it.liveStreamingDetails.activeLiveChatId, title: it.snippet.title };
  }
  const b = await gfetch(`${API}/youtube/v3/liveBroadcasts?part=snippet&broadcastStatus=active&broadcastType=all&maxResults=5`);
  const live = b.items?.find((x) => x.snippet?.liveChatId);
  if (!live) throw new Error('No live broadcast on your channel right now. Go live on YouTube, or paste the video link.');
  return { liveChatId: live.snippet.liveChatId, title: live.snippet.title };
}
/** Turn a YouTube chat item into gather's chat-feed shape (super chats, stickers and memberships included). */
export function toFeedItem(it) {
  const s = it.snippet || {}, a = it.authorDetails || {};
  let text = s.displayMessage || '', paid = '';
  if (s.type === 'superChatEvent') { paid = s.superChatDetails?.amountDisplayString || 'Super Chat'; text = s.superChatDetails?.userComment || text || 'sent a Super Chat'; }
  else if (s.type === 'superStickerEvent') { paid = s.superStickerDetails?.amountDisplayString || 'Sticker'; text = text || 'sent a Super Sticker'; }
  else if (s.type === 'newSponsorEvent') { paid = 'New member'; text = text || `joined as a member${s.newSponsorDetails?.memberLevelName ? ` (${s.newSponsorDetails.memberLevelName})` : ''}`; }
  else if (s.type === 'memberMilestoneChatEvent') { paid = `Member · ${s.memberMilestoneChatDetails?.memberMonth || ''} mo`; text = s.memberMilestoneChatDetails?.userComment || text || 'member milestone'; }
  else if (s.type === 'membershipGiftingEvent') { paid = 'Gifted'; text = text || `gifted ${s.membershipGiftingDetails?.giftMembershipsCount || ''} memberships`; }
  else if (s.type !== 'textMessageEvent') return null;
  return { id: 'yt-' + it.id, ytId: it.id, src: 'youtube', name: a.displayName || 'viewer', channel: a.channelId || '', color: a.isChatOwner ? '#ffd600' : a.isChatModerator ? '#5e84f1' : a.isChatSponsor ? '#2ba640' : '', text: String(text).slice(0, 500), ts: Date.parse(s.publishedAt) || Date.now(), paid: paid.slice(0, 16) };
}
/**
 * Poll a live chat at the pace YouTube asks for (never faster than every 5 s, to stay inside the daily quota).
 * Calls onItems(feedItems) and onStatus(state, detail). Returns stop().
 */
export function pollLiveChat(liveChatId, onItems, onStatus) {
  let page = '', stopped = false, timer = 0, fails = 0, first = true;
  async function tick() {
    if (stopped) return;
    let wait = 5000;
    try {
      const r = await gfetch(`${API}/youtube/v3/liveChat/messages?liveChatId=${encodeURIComponent(liveChatId)}&part=snippet,authorDetails&maxResults=200${page ? `&pageToken=${page}` : ''}`);
      page = r.nextPageToken || page;
      wait = Math.max(5000, Number(r.pollingIntervalMillis) || 5000);
      const items = (r.items || []).map(toFeedItem).filter(Boolean);
      // On connect, keep only the last few messages so the overlay doesn't flood with history.
      onItems(first ? items.slice(-10) : items);
      first = false; fails = 0; onStatus('live');
    } catch (e) {
      if (e.reason === 'liveChatEnded' || e.status === 404) { onStatus('ended', e.message); return; }
      if (e.status === 401) { onStatus('error', 'Your Google sign-in expired. Connect again.'); return; }
      fails++; onStatus('error', e.message); wait = Math.min(120_000, 5000 * 2 ** fails);
    }
    timer = setTimeout(tick, wait);
  }
  tick();
  return () => { stopped = true; clearTimeout(timer); };
}
/** Moderate on YouTube itself: delete a message, time out (seconds) or ban a viewer. */
export async function ytModerate(kind, liveChatId, item, secs) {
  await googleToken(['youtube']);
  if (kind === 'hide') return gfetch(`${API}/youtube/v3/liveChat/messages?id=${encodeURIComponent(item.ytId)}`, { method: 'DELETE' });
  if (!item.channel) throw new Error('This message has no YouTube channel to act on.');
  const snippet = { liveChatId, type: kind === 'block' ? 'permanent' : 'temporary', bannedUserDetails: { channelId: item.channel } };
  if (kind !== 'block') snippet.banDurationSeconds = Math.round(secs);
  return gfetch(`${API}/youtube/v3/liveChat/bans?part=snippet`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ snippet }) });
}
