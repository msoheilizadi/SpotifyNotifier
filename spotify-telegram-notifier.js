// spotify-telegram-notifier.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const USER_A = process.env.TELEGRAM_USER_A_ID && Number(process.env.TELEGRAM_USER_A_ID);
const USER_B = process.env.TELEGRAM_USER_B_ID && Number(process.env.TELEGRAM_USER_B_ID);

const TELEGRAM_USER_A_NAME = process.env.TELEGRAM_USER_A_NAME || null;
const TELEGRAM_USER_B_NAME = process.env.TELEGRAM_USER_B_NAME || null;

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

// normalize playlist id if user pasted full URL
function normalizePlaylistId(raw) {
  if (!raw) return raw;
  const last = raw.split('/').pop();
  return last.split('?')[0];
}
const PLAYLIST_ID = normalizePlaylistId(process.env.SPOTIFY_PLAYLIST_ID);

const POLL_INTERVAL_SECONDS = Number(process.env.POLL_INTERVAL_SECONDS || 60);
const STATE_FILE = path.resolve(__dirname, 'state.json');
const NOTIF_LOG = path.resolve(__dirname, 'notifications.log');

if (!TELEGRAM_TOKEN || !USER_A || !USER_B || !SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !PLAYLIST_ID) {
  console.error('Missing required env vars. Check .env (TELEGRAM_BOT_TOKEN, TELEGRAM_USER_A_ID, TELEGRAM_USER_B_ID, SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_PLAYLIST_ID).');
  process.exit(1);
}

// parse SPOTIFY_TO_TELEGRAM_MAP like "spotifyId:A,spotifyId2:B" OR "spotifyId:111111111,spotifyId2:222222222"
const spotifyMapRaw = process.env.SPOTIFY_TO_TELEGRAM_MAP || '';
const spotifyMap = {};
spotifyMapRaw.split(',').map(s => s.trim()).filter(Boolean).forEach(pair => {
  const [k, vRaw] = pair.split(':').map(x => x && x.trim());
  if (!k || !vRaw) return;
  const upper = vRaw.toUpperCase && vRaw.toUpperCase();
  const v = (upper === 'A' || upper === 'B') ? upper : Number(vRaw);
  spotifyMap[k] = v; // value is either 'A'|'B' or a Number (telegram id)
});

// parse SPOTIFY_NAME_MAP like "spotifyId:سهیل,spotifyId2:عسل"
const spotifyNameMapRaw = process.env.SPOTIFY_NAME_MAP || '';
const spotifyNameMap = {};
spotifyNameMapRaw.split(',').map(s => s.trim()).filter(Boolean).forEach(pair => {
  const [k, v] = pair.split(':').map(x => x && x.trim());
  if (k && v) spotifyNameMap[k] = v;
});

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

// simple state loader/saver
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// simple logger (console + file)
function log(level, msg) {
  const time = new Date().toISOString();
  const line = `[${time}] [${level}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(NOTIF_LOG, line + '\n');
  } catch (e) {
    console.error('Failed to write notification log:', e.message);
  }
}

// Spotify: get token via Client Credentials
let spotifyToken = null;
let spotifyTokenExpiry = 0;

async function getSpotifyToken() {
  const now = Date.now();
  if (spotifyToken && now < spotifyTokenExpiry - 5000) return spotifyToken;
  const tokenResp = await axios({
    method: 'post',
    url: 'https://accounts.spotify.com/api/token',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64')
    },
    data: 'grant_type=client_credentials'
  });
  spotifyToken = tokenResp.data.access_token;
  spotifyTokenExpiry = now + (tokenResp.data.expires_in * 1000);
  return spotifyToken;
}

// get playlist snapshot id (to cheaply check change)
async function getPlaylistSnapshotId() {
  const token = await getSpotifyToken();
  const url = `https://api.spotify.com/v1/playlists/${PLAYLIST_ID}`;
  try {
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      params: { fields: 'snapshot_id' }
    });
    if (!resp.data || typeof resp.data.snapshot_id === 'undefined') {
      throw new Error(`No snapshot_id in response: ${JSON.stringify(resp.data).slice(0,800)}`);
    }
    return resp.data.snapshot_id;
  } catch (err) {
    if (err.response && err.response.data) {
      throw new Error(`Spotify API error (snapshot): ${JSON.stringify(err.response.data)}`);
    }
    throw err;
  }
}

// fetch all tracks (paginated) with added_by and added_at and track info
async function fetchAllPlaylistTracks() {
  const token = await getSpotifyToken();
  const items = [];
  let limit = 100;
  let offset = 0;
  try {
    while (true) {
      const url = `https://api.spotify.com/v1/playlists/${PLAYLIST_ID}/tracks`;
      const resp = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          fields: 'items(added_at,added_by(id,display_name),track(id,name,artists(name),external_urls(spotify))),next',
          limit,
          offset
        }
      });

      if (!resp || !resp.data) {
        throw new Error(`Empty response from Spotify for tracks. status=${resp && resp.status}`);
      }
      if (!Array.isArray(resp.data.items)) {
        throw new Error(`Unexpected response: resp.data.items is not an array. resp.data=${JSON.stringify(resp.data).slice(0,1000)}`);
      }

      items.push(...resp.data.items);

      if (!resp.data.next) break;
      offset += limit;
    }

    return items.map(it => ({
      added_at: it.added_at,
      added_by: it.added_by,
      track: it.track
    }));
  } catch (err) {
    if (err.response && err.response.data) {
      throw new Error(`Spotify API error (tracks): ${JSON.stringify(err.response.data)}`);
    }
    throw err;
  }
}

// Escape for Markdown (basic)
function escapeMarkdown(text) {
  if (!text) return '';
  return String(text).replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

// derive a friendly adder name (check spotifyNameMap first)
function friendlyAdderName(addedBy) {
  if (!addedBy) return 'Someone';
  if (addedBy.id && spotifyNameMap[addedBy.id]) return spotifyNameMap[addedBy.id];
  if (addedBy.display_name) return addedBy.display_name;
  return addedBy.id || 'Someone';
}

// keep the exact simple messaging you had: "{adder} آهنگ جدید اضافه کرد."
function formatShortMessage(adderName) {
  return `${adderName} آهنگ جدید اضافه کرد.`;
}

// decide recipients: supports mapping values 'A'/'B' or numeric telegram ids
function recipientsForAdder(addedBy) {
  if (!addedBy) return [USER_A, USER_B];

  const keyCandidates = [addedBy.id, (addedBy.display_name || '').toLowerCase(), (addedBy.display_name || '')];
  for (const key of keyCandidates) {
    if (!key) continue;
    const mapped = spotifyMap[key];
    if (typeof mapped === 'undefined') continue;

    if (mapped === 'A') return [USER_B];
    if (mapped === 'B') return [USER_A];

    if (typeof mapped === 'number' && !Number.isNaN(mapped)) {
      if (mapped === USER_A) return [USER_B];
      if (mapped === USER_B) return [USER_A];
      // mapped to other numeric -> notify that specific id only
      return [mapped];
    }
  }

  // fallback: notify both
  return [USER_A, USER_B];
}

async function notifyTelegram(userId, text) {
  const logPrefix = `notify->to:${userId}`;
  log('INFO', `${logPrefix} Attempting to send message: "${text.replace(/\n/g,' ')}"`);
  try {
    const res = await bot.sendMessage(userId, text, { parse_mode: 'Markdown', disable_web_page_preview: true });
    log('INFO', `${logPrefix} Sent (message_id=${res.message_id})`);
    return true;
  } catch (err) {
    const errBody = err && err.response && err.response.data ? JSON.stringify(err.response.data) : (err && err.message ? err.message : String(err));
    log('ERROR', `${logPrefix} Failed to send: ${errBody}`);
    return false;
  }
}

async function checkOnce() {
  try {
    const state = loadState() || {};
    const lastSnapshot = state.lastSnapshotId || null;
    const lastSeenAddedAt = state.lastSeenAddedAt || null; // ISO string

    log('DEBUG', `Starting check. lastSnapshot=${lastSnapshot}, lastSeenAddedAt=${lastSeenAddedAt}`);

    const currentSnapshot = await getPlaylistSnapshotId();
    log('DEBUG', `Current snapshot_id=${currentSnapshot}`);

    if (!lastSnapshot) {
      log('INFO', 'First run: initializing state and not sending notifications.');
      const nowIso = new Date().toISOString();
      saveState({ lastSnapshotId: currentSnapshot, lastSeenAddedAt: nowIso });
      return;
    }

    if (currentSnapshot === lastSnapshot) {
      log('DEBUG', 'No changes in playlist (snapshot same).');
      return;
    }

    log('INFO', 'Playlist changed. Fetching tracks to find new additions...');
    const allTracks = await fetchAllPlaylistTracks();
    allTracks.sort((a,b) => new Date(a.added_at) - new Date(b.added_at));

    const newItems = lastSeenAddedAt
      ? allTracks.filter(it => new Date(it.added_at) > new Date(lastSeenAddedAt))
      : allTracks;

    log('DEBUG', `Found total tracks=${allTracks.length}, newItems=${newItems.length}`);

    if (newItems.length === 0) {
      log('WARN', 'Snapshot changed but no items newer than lastSeenAddedAt were found. Updating state.');
      saveState({ lastSnapshotId: currentSnapshot, lastSeenAddedAt: new Date().toISOString() });
      return;
    }

    log('INFO', `Found ${newItems.length} new track(s). Preparing notifications...`);
    for (const item of newItems) {
      const recipients = recipientsForAdder(item.added_by); // array of telegram ids
      const adderName = friendlyAdderName(item.added_by);
      const aEscaped = escapeMarkdown(adderName);
      const text = formatShortMessage(aEscaped); // keep message simple: only adder

      for (const r of recipients) {
        log('DEBUG', `About to notify telegramId=${r}, adder=${adderName}`);
        const ok = await notifyTelegram(r, text);
        await new Promise(res => setTimeout(res, 350));
        if (!ok) {
          log('ERROR', `Failed to notify ${r} about addition by ${adderName}.`);
        } else {
          log('INFO', `Notification sent to ${r} regarding addition by ${adderName}.`);
        }
      }
    }

    const newest = newItems[newItems.length - 1];
    saveState({ lastSnapshotId: currentSnapshot, lastSeenAddedAt: newest.added_at });
    log('INFO', 'State updated.');
  } catch (err) {
    const msg = (err && err.response && err.response.data) ? JSON.stringify(err.response.data) : (err && err.message ? err.message : String(err));
    log('ERROR', `Error during checkOnce: ${msg}`);
  }
}

async function startPolling() {
  log('INFO', `Starting poll every ${POLL_INTERVAL_SECONDS}s for playlist ${PLAYLIST_ID}`);
  await checkOnce();
  setInterval(checkOnce, POLL_INTERVAL_SECONDS * 1000);
}

startPolling();
