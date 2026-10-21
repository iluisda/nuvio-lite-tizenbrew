'use strict';
/*
 * Nuvio Bridge - runs on your LAN server (e.g. NAS/Unraid), listens on :7070.
 * - Ściąga providery Nuvio z repozytorium (manifest.json) i uruchamia getStreams() w Node.
 * - Wystawia proste REST API dla starego telewizora Samsung (Tizen 2.3, UE55J6350).
 * - Proxuje TMDB (katalogi/szczegóły) oraz strumienie (dokłada nagłówki, których AVPlay nie ustawi).
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ---------- Konfiguracja ----------
const PORT = process.env.PORT || 7070;
const TMDB_KEY = process.env.TMDB_KEY || 'YOUR_TMDB_API_KEY';
const TMDB = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';
const REPOS = (process.env.NUVIO_REPOS ||
  'https://raw.githubusercontent.com/yoruix/nuvio-providers/main/manifest.json'
).split(',').map(s => s.trim()).filter(Boolean);
const PROVIDER_DIR = path.join(__dirname, 'providers');
const STREAM_TIMEOUT = 25000;
const LANG = process.env.TMDB_LANG || 'es-AR';

if (!fs.existsSync(PROVIDER_DIR)) fs.mkdirSync(PROVIDER_DIR, { recursive: true });

// ---------- narzędzia HTTP ----------
function httpGet(u, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const lib = u.startsWith('https') ? https : http;
    const req = lib.get(u, { headers: opts.headers || {} }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, u).toString();
        res.resume();
        return resolve(httpGet(next, opts));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(opts.timeout || 20000, () => { req.destroy(new Error('timeout')); });
  });
}
async function getJSON(u, headers) {
  const r = await httpGet(u, { headers });
  return JSON.parse(r.body.toString('utf8'));
}
function withTimeout(p, ms, tag) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout:' + (tag || ''))), ms))
  ]);
}

// ---------- Konto Nuvio (Supabase api.nuvio.tv) — cała robota po stronie bridge ----------
const SUPA = process.env.NUVIO_API || 'https://api.nuvio.tv';
const ANON_KEY = process.env.NUVIO_ANON_KEY || 'YOUR_NUVIO_SUPABASE_ANON_KEY';
const SESSION_FILE = path.join(__dirname, 'session.json');

let ACC = { access: null, refresh: null, profileId: null, user: null };
try { if (fs.existsSync(SESSION_FILE)) ACC = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch (e) {}
function saveSession() { try { fs.writeFileSync(SESSION_FILE, JSON.stringify(ACC)); } catch (e) {} }

// helper: request JSON z ciałem (POST/GET) do Supabase
function supaReq(method, urlPath, bodyObj, bearer) {
  return new Promise((resolve, reject) => {
    const data = bodyObj != null ? Buffer.from(JSON.stringify(bodyObj)) : null;
    const url = new URL(urlPath.indexOf('http') === 0 ? urlPath : SUPA + urlPath);
    const opts = {
      method, hostname: url.hostname, path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'apikey': ANON_KEY,
        'Authorization': 'Bearer ' + (bearer || ANON_KEY)
      }
    };
    if (data) opts.headers['Content-Length'] = data.length;
    const r = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    r.on('error', reject);
    r.setTimeout(20000, () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}

function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function jwtExpired(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return (Number(p.exp) || 0) <= Math.floor(Date.now() / 1000) + 30;
  } catch (e) { return true; }
}

// anon token do procesu logowania
async function anonAuth() {
  let r = await supaReq('POST', '/auth/v1/signup', { data: { tv_client: 'tizen' } });
  if (r.status >= 300 || !r.json || !r.json.access_token) {
    r = await supaReq('POST', '/auth/v1/token?grant_type=anonymous', {});
  }
  if (r.json && r.json.access_token) return r.json.access_token;
  throw new Error('anon auth: ' + (r.text || r.status));
}

async function refreshUserToken() {
  if (!ACC.refresh) return false;
  const r = await supaReq('POST', '/auth/v1/token?grant_type=refresh_token', { refresh_token: ACC.refresh });
  if (r.json && r.json.access_token) {
    ACC.access = r.json.access_token; ACC.refresh = r.json.refresh_token || ACC.refresh; saveSession(); return true;
  }
  return false;
}
async function userToken() {
  if (!ACC.access) return null;
  if (jwtExpired(ACC.access)) { await refreshUserToken(); }
  return ACC.access;
}

// stan trwającej sesji logowania QR
let LOGIN = null; // { code, nonce, anon, url }

async function loginStart() {
  const anon = await anonAuth();
  const nonce = b64url(require('crypto').randomBytes(24));
  const r = await supaReq('POST', '/rest/v1/rpc/start_tv_login_session',
    { p_device_nonce: nonce, p_redirect_base_url: 'https://nuvio.tv/tv-login', p_device_name: 'Samsung TV (Tizen)' }, anon);
  const s = r.json && r.json[0];
  if (!s) throw new Error('start login: ' + (r.text || r.status));
  const url = s.qr_content || s.web_url || ('https://nuvio.tv/tv-login?code=' + s.code);
  LOGIN = { code: s.code, nonce, anon, url };
  return { code: s.code, url, pollInterval: Number(s.poll_interval_seconds || 3) };
}

async function loginPoll() {
  if (!LOGIN) return { status: 'none' };
  const r = await supaReq('POST', '/rest/v1/rpc/poll_tv_login_session',
    { p_code: LOGIN.code, p_device_nonce: LOGIN.nonce }, LOGIN.anon);
  const status = r.json && r.json[0] && r.json[0].status;
  if (status === 'approved' || status === 'authorized' || status === 'completed') {
    // wymiana na sesję użytkownika
    const ex = await supaReq('POST', '/functions/v1/tv-logins-exchange',
      { code: LOGIN.code, device_nonce: LOGIN.nonce }, LOGIN.anon);
    const tk = ex.json || {};
    const access = tk.access_token || (tk.session && tk.session.access_token);
    const refresh = tk.refresh_token || (tk.session && tk.session.refresh_token);
    if (access && refresh) {
      ACC.access = access; ACC.refresh = refresh; ACC.user = tk.user || (tk.session && tk.session.user) || null;
      LOGIN = null;
      await resolveProfile();
      saveSession();
      return { status: 'ok' };
    }
    return { status: 'exchange_failed', detail: ex.text };
  }
  return { status: status || 'pending' };
}

async function resolveProfile() {
  const tok = await userToken(); if (!tok) return null;
  let r = await supaReq('POST', '/rest/v1/rpc/sync_pull_profiles', {}, tok);
  let rows = r.json;
  if (!Array.isArray(rows)) {
    r = await supaReq('GET', '/rest/v1/tv_profiles?select=*', null, tok); rows = r.json;
  }
  if (Array.isArray(rows) && rows.length) {
    ACC.profiles = rows.map(x => ({ id: x.id, index: x.profile_index, name: x.name }));
    // wybrany profil: zapamiętany, inaczej pierwszy (profile_index 1)
    const chosen = rows.find(x => x.profile_index === ACC.profileIndex) || rows.find(x => x.profile_index === 1) || rows[0];
    ACC.profileId = chosen.id || null;
    ACC.profileIndex = chosen.profile_index != null ? chosen.profile_index : 1;
    ACC.profileName = chosen.name || 'Profil';
    saveSession();
  }
  return ACC.profileIndex;
}

// Continue watching z konta, wzbogacone o metadane TMDB
async function getContinue() {
  const tok = await userToken(); if (!tok) return [];
  if (ACC.profileIndex == null) await resolveProfile();
  const r = await supaReq('POST', '/rest/v1/rpc/sync_pull_watch_progress', { p_profile_id: ACC.profileIndex }, tok);
  const rows = Array.isArray(r.json) ? r.json : [];
  const items = [];
  for (const row of rows) {
    const cid = row.content_id || row.contentId || '';
    const ctype = (row.content_type || row.contentType || 'movie');
    const posMs = Number(row.position != null ? row.position : (row.position_ms || 0));
    const durMs = Number(row.duration != null ? row.duration : (row.duration_ms || 0));
    const pct = durMs > 0 ? Math.round(posMs / durMs * 100) : 0;
    if (pct >= 95) continue; // obejrzane
    items.push({
      contentId: cid, type: ctype === 'tv' || ctype === 'series' ? 'series' : 'movie',
      season: row.season != null ? Number(row.season) : null,
      episode: row.episode != null ? Number(row.episode) : null,
      positionMs: posMs, durationMs: durMs, pct: pct,
      updated: Number(row.last_watched || row.updated_at || 0)
    });
  }
  items.sort((a, b) => b.updated - a.updated);
  // wzbogać o TMDB (id może być tt... imdb lub tmdb numeric)
  const top = items.slice(0, 20);
  await Promise.all(top.map(async it => {
    try {
      let tmdbId = it.contentId, mt = it.type === 'series' ? 'tv' : 'movie';
      if (String(it.contentId).indexOf('tt') === 0) {
        const f = await getJSON(`${TMDB}/find/${it.contentId}?api_key=${TMDB_KEY}&external_source=imdb_id&language=${LANG}`);
        const hit = (f.movie_results && f.movie_results[0]) || (f.tv_results && f.tv_results[0]);
        if (hit) { tmdbId = hit.id; mt = f.tv_results && f.tv_results[0] ? 'tv' : 'movie'; }
      } else if (String(it.contentId).indexOf('tmdb:') === 0) { tmdbId = it.contentId.split(':')[1]; }
      it.tmdbId = tmdbId; it.type = mt === 'tv' ? 'series' : 'movie';
      const d = await getJSON(`${TMDB}/${mt}/${tmdbId}?api_key=${TMDB_KEY}&language=${LANG}`);
      it.title = d.title || d.name || it.contentId;
      it.poster = d.poster_path ? IMG + '/w342' + d.poster_path : '';
    } catch (e) { it.title = it.contentId; it.poster = ''; }
  }));
  return top;
}

function jwtSub() {
  try { return JSON.parse(Buffer.from(ACC.access.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')).sub; } catch (e) { return null; }
}
// Lista wtyczek zainstalowanych na koncie użytkownika
async function getUserPlugins() {
  const tok = await userToken(); if (!tok) return [];
  if (ACC.profileIndex == null) await resolveProfile();
  // wtyczki/źródła użytkownika są w tabeli `addons` (kolumny: url,name,enabled,sort_order,profile_id)
  let r = await supaReq('GET', `/rest/v1/addons?profile_id=eq.${ACC.profileIndex}&select=url,name,enabled,sort_order&order=sort_order.asc`, null, tok);
  let rows = Array.isArray(r.json) ? r.json : [];
  if (!rows.length) { // fallback: wszystkie addony usera (gdyby profile_id nie pasował)
    r = await supaReq('GET', '/rest/v1/addons?select=url,name,enabled,sort_order,profile_id&order=sort_order.asc', null, tok);
    rows = Array.isArray(r.json) ? r.json : [];
  }
  return rows.map(x => ({ name: x.name || 'Addon', url: x.url || '', enabled: x.enabled !== false }))
    .filter(x => x.url);
}

function readJsonBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function mapLibraryRow(x) {
  return { id: x.content_id || x.contentId || '', type: (x.content_type || x.contentType) === 'series' ? 'series' : 'movie',
    title: x.name || x.title || '', poster: x.poster || '', backdrop: x.background || '',
    overview: x.description || '', year: String(x.release_info || x.releaseInfo || '').slice(0, 4),
    rating: x.imdb_rating != null ? Number(x.imdb_rating) : null,
    genres: Array.isArray(x.genres) ? x.genres : [], addedAt: Number(x.added_at || x.addedAt) || Date.now() };
}
function toLibraryRow(i) {
  return { content_id: i.id || i.content_id, content_type: i.type || i.content_type || 'movie',
    name: i.title || i.name || '', poster: i.poster || null,
    poster_shape: String(i.posterShape || i.poster_shape || 'POSTER').toUpperCase(),
    background: i.backdrop || i.background || null, description: i.overview || i.description || '',
    release_info: i.year || i.release_info || '',
    imdb_rating: i.rating == null && i.imdb_rating == null ? null : Number(i.rating != null ? i.rating : i.imdb_rating),
    genres: i.genres || [], addon_base_url: i.addonBaseUrl || i.addon_base_url || null,
    added_at: Number(i.addedAt || i.added_at) || Date.now() };
}
function mapWatchedRow(x) {
  return { id: x.content_id || x.contentId || '', type: (x.content_type || x.contentType) === 'series' ? 'series' : 'movie',
    title: x.title || x.name || '', season: x.season == null ? null : Number(x.season),
    episode: x.episode == null ? null : Number(x.episode), watchedAt: Number(x.watched_at || x.watchedAt) || 0 };
}

async function pushProgress(p) {
  const tok = await userToken(); if (!tok) return false;
  if (ACC.profileIndex == null) await resolveProfile();
  const isSeries = p.type === 'series' || p.type === 'tv';
  const ctype = isSeries ? 'series' : 'movie';
  // content_id MUSI być imdb tt (żeby wznawianie działało na innych urządzeniach)
  let imdb = String(p.contentId || '');
  if (imdb.indexOf('tt') !== 0) {
    if (imdb.indexOf('tmdb:') === 0) imdb = imdb.split(':')[1];
    const resolved = await tmdbToImdb(p.tmdbId || imdb, isSeries ? 'tv' : 'movie');
    if (resolved) imdb = resolved;
  }
  const s = p.season != null ? Number(p.season) : null;
  const e = p.episode != null ? Number(p.episode) : null;
  const videoId = isSeries ? `${imdb}:${s}:${e}` : imdb;
  const progressKey = isSeries ? `${imdb}_s${s}e${e}` : imdb;
  const entry = {
    content_id: imdb, content_type: ctype, video_id: videoId,
    season: isSeries ? s : null, episode: isSeries ? e : null,
    position: Math.max(0, Math.round(Number(p.positionMs) || 0)),
    duration: Math.max(0, Math.round(Number(p.durationMs) || 0)),
    last_watched: Date.now(),
    progress_key: progressKey
  };
  const r = await supaReq('POST', '/rest/v1/rpc/sync_push_watch_progress',
    { p_profile_id: ACC.profileIndex, p_entries: [entry] }, tok);
  console.log('[progress] push', progressKey, entry.position + '/' + entry.duration, '->', r.status);
  return r.status < 300;
}

// ---------- Ładowanie providerów Nuvio ----------
let PROVIDERS = []; // { id, name, mod, supportedTypes }

async function loadProviders() {
  const loaded = [];
  for (const repo of REPOS) {
    let manifest;
    try { manifest = await getJSON(repo); }
    catch (e) { console.log('[providers] nie mogę pobrać manifestu', repo, e.message); continue; }
    const base = repo.replace(/\/manifest\.json.*$/, '');
    const scrapers = manifest.scrapers || manifest.providers || [];
    for (const s of scrapers) {
      if (s.enabled === false) continue;
      const id = s.id || s.name;
      const fileUrl = base + '/' + (s.filename || ('providers/' + id + '.js'));
      const localPath = path.join(PROVIDER_DIR, id + '.js');
      try {
        const r = await httpGet(fileUrl);
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        fs.writeFileSync(localPath, r.body);
        delete require.cache[require.resolve(localPath)];
        const mod = require(localPath);
        if (typeof mod.getStreams !== 'function') throw new Error('brak getStreams');
        loaded.push({ id, name: s.name || id, mod, supportedTypes: s.supportedTypes || ['movie', 'tv'] });
        console.log('[providers] OK', id);
      } catch (e) {
        console.log('[providers] pominięto', id, '-', e.message);
      }
    }
  }
  PROVIDERS = loaded;
  console.log('[providers] załadowano', PROVIDERS.length);
}

// ---------- Addony Stremio z konta użytkownika ----------
let ADDONS_CACHE = { ts: 0, list: [] };
function addonBase(url) {
  // baza do zasobów: usuń końcowe /manifest.json (i ewentualny query)
  let u = url.split('#')[0];
  if (/\/manifest\.json(\?.*)?$/.test(u)) return u.replace(/\/manifest\.json(\?.*)?$/, '');
  if (/\/manifest(\/|\?|$)/.test(u)) return u.replace(/\/manifest.*$/, '');
  return u.replace(/\/$/, '');
}
function manifestUrl(url) {
  if (/manifest/.test(url)) return url;
  return url.replace(/\/$/, '') + '/manifest.json';
}
async function getUserAddons() {
  if (Date.now() - ADDONS_CACHE.ts < 300000 && ADDONS_CACHE.list.length) return ADDONS_CACHE.list;
  const raw = await getUserPlugins();
  const list = [];
  await Promise.all(raw.filter(a => a.enabled).map(async a => {
    try {
      const m = await getJSON(manifestUrl(a.url));
      const resources = (m.resources || []).map(r => typeof r === 'string' ? r : r.name);
      list.push({ name: a.name, base: addonBase(a.url), resources, types: m.types || [] });
    } catch (e) { console.log('[addon] manifest fail', a.name, e.message); }
  }));
  if (list.length) ADDONS_CACHE = { ts: Date.now(), list };
  return list;
}
async function tmdbToImdb(tmdbId, mt) {
  try { const j = await getJSON(`${TMDB}/${mt}/${tmdbId}/external_ids?api_key=${TMDB_KEY}`); return j.imdb_id || null; } catch (e) { return null; }
}

// ---------- Catálogos de addons + Home/Colecciones (Lite v2, 18-oct) ----------
let MANI_CACHE = { ts: 0, byId: {}, byBase: {}, list: [] };
async function getAllManifests() {
  if (Date.now() - MANI_CACHE.ts < 300000 && MANI_CACHE.list.length) return MANI_CACHE;
  const raw = await getUserPlugins();
  const byId = {}, byBase = {}, list = [];
  await Promise.all(raw.filter(a => a.enabled).map(async a => {
    try {
      const m = await getJSON(manifestUrl(a.url));
      const rec = { name: a.name, base: addonBase(a.url), id: m.id || a.name,
        catalogs: (m.catalogs || []), resources: (m.resources || []).map(r => typeof r === 'string' ? r : r.name), types: m.types || [] };
      byId[rec.id] = rec; byBase[rec.base] = rec; list.push(rec);
    } catch (e) { console.log('[manifest] fail', a.name, e.message); }
  }));
  if (list.length) MANI_CACHE = { ts: Date.now(), byId, byBase, list };
  return MANI_CACHE;
}
function findManifest(mc, addonId) {
  return mc.byId[addonId] || mc.byBase[addonId] ||
    mc.list.find(r => r.name === addonId) ||
    mc.list.find(r => String(r.id).indexOf(String(addonId)) === 0 || String(addonId).indexOf(String(r.id)) === 0) || null;
}

// Tipos nativos de Stremio (movie/series/channel/sport/tv/collection/anime.*) — no colapsar a movie.
const KNOWN_TYPES = { movie: 'movie', series: 'series', tv: 'tv', channel: 'channel', sport: 'sport', collection: 'collection', anime: 'series', 'anime.movie': 'movie', 'anime.series': 'series' };
function nativeType(value, fallback) {
  const t = String(value || fallback || '').toLowerCase();
  return KNOWN_TYPES[t] || (t || 'movie');
}
function addonResources(m) {
  return (m.resources || []).map(r => typeof r === 'string' ? r : r.name);
}
function addonSupports(m, resource, type, id) {
  if (addonResources(m).indexOf(resource) < 0) return false;
  const spec = (m.resources || []).find(r => typeof r !== 'string' && r.name === resource);
  if (spec) {
    const types = spec.types || [];
    if (types.length && types.indexOf(type) < 0) return false;
    const prefixes = spec.idPrefixes || [];
    if (prefixes.length && id && !prefixes.some(p => String(id).indexOf(p) === 0)) return false;
  } else if ((m.types || []).length && type !== 'movie' && type !== 'series' && (m.types || []).indexOf(type) < 0) {
    return false;
  }
  return true;
}
function mapAddonMeta(m, addonId, reqType) {
  const type = nativeType(m.type, reqType);
  const videos = Array.isArray(m.videos) ? m.videos : [];
  const seasons = {};
  videos.forEach(v => {
    const sn = Number(v.season);
    if (!sn || sn < 1) return;
    (seasons[sn] = seasons[sn] || []).push({
      episode: Number(v.episode) || 0,
      name: v.name || v.title || ('Episodio ' + v.episode),
      overview: v.overview || '',
      still: v.thumbnail || '',
      released: v.released || ''
    });
  });
  const out = {
    id: m.id || '', type,
    title: m.name || m.title || '',
    overview: m.description || m.overview || '',
    poster: m.poster || m.landscapePoster || '',
    backdrop: m.background || m.backdrop || '',
    logo: m.logo || '',
    year: String(m.releaseInfo || m.year || '').slice(0, 4),
    rating: m.imdbRating != null ? Number(m.imdbRating) : null,
    runtime: m.runtime || null,
    genres: Array.isArray(m.genre) ? m.genre : (Array.isArray(m.genres) ? m.genres : []),
    addonId: addonId || null
  };
  const keys = Object.keys(seasons).map(Number).sort((a, b) => a - b);
  if (keys.length) {
    out.seasons = keys.map(sn => ({ season: sn, name: 'Temporada ' + sn, episodes: seasons[sn].length }));
    out._episodes = seasons;
  }
  if (m.collection) out.collection = m.collection;
  return out;
}
const ADDON_META_CACHE = {};
async function fetchAddonMeta(type, id) {
  const ck = type + '|' + id;
  const cc = ADDON_META_CACHE[ck];
  if (cc && Date.now() - cc.ts < 600000) return cc.data;
  const mc = await getAllManifests();
  const candidates = mc.list.filter(m => addonSupports(m, 'meta', type, id));
  console.log('[addon-meta]', type, id.slice(0, 32), 'candidatos:', candidates.map(m => m.id).join(',') || 'ninguno');
  for (const m of candidates) {
    try {
      const j = await withTimeout(getJSON(`${m.base}/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`), 12000, m.name);
      if (j && j.meta && (j.meta.name || j.meta.title)) {
        const data = mapAddonMeta(j.meta, m.id, type);
        ADDON_META_CACHE[ck] = { ts: Date.now(), data };
        return data;
      }
    } catch (e) { console.log('[addon-meta]', m.name, e.message); }
  }
  return null;
}
function mapStreamItem(s, a) {
  const ph = s.behaviorHints && s.behaviorHints.proxyHeaders && s.behaviorHints.proxyHeaders.request;
  const desc = (s.description || s.title || s.name || '').toString();
  const fn = (s.behaviorHints && s.behaviorHints.filename) || '';
  let sizeBytes = (s.behaviorHints && s.behaviorHints.videoSize) || 0;
  if (!sizeBytes) { const m = desc.match(/([\d.]+)\s?(GB|MB)/i); if (m) sizeBytes = parseFloat(m[1]) * (m[2].toUpperCase() === 'GB' ? 1073741824 : 1048576); }
  const base = {
    provider: a.name, name: (s.name || a.name).toString().replace(/\n/g, ' '), _addon: true,
    title: ((s.name || a.name) + (fn ? '  · ' + fn : '')).toString().replace(/\n/g, ' '),
    desc: desc,
    size: sizeBytes || null,
    quality: qualFromText(desc + ' ' + (s.name || '') + ' ' + fn),
    fn: fn, headers: ph || s.headers || null
  };
  if (s.url) { base.url = s.url; base.kind = 'direct'; return base; }
  if (s.infoHash) {
    const trackers = (s.sources || []).filter(x => /^tracker:/.test(x)).map(x => x.slice(8));
    base.kind = 'torrent'; base.infoHash = s.infoHash;
    base.magnet = magnetWithTrackers(s.infoHash, fn || base.title || 'video', trackers);
    base.fileIdx = (typeof s.fileIdx === 'number') ? s.fileIdx : null;
    return base;
  }
  if (s.externalUrl) { base.kind = 'external'; base.externalUrl = s.externalUrl; return base; }
  return null;
}
async function fetchAddonStreamsNative(type, id) {
  const mc = await getAllManifests();
  const usable = mc.list.filter(m => addonSupports(m, 'stream', type, id));
  console.log('[addon-live]', type, id.slice(0, 32), 'addons:', usable.map(m => m.id).join(',') || 'ninguno');
  const jobs = usable.map(async m => {
    try {
      const j = await withTimeout(getJSON(`${m.base}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`), 20000, m.name);
      return ((j && j.streams) || []).map(s => mapStreamItem(s, m)).filter(Boolean);
    } catch (e) { console.log('[addon-live]', m.name, e.message); return []; }
  });
  const res = await Promise.all(jobs);
  const all = [].concat.apply([], res);
  all.forEach(x => {
    x.live = true;
    x.hls = /\.m3u8(\?|$)/i.test(x.url || '') || type === 'channel' || type === 'tv';
  });
  return all;
}
async function getCollectionsBlob() {
  const tok = await userToken(); if (!tok) throw new Error('sin sesión');
  if (ACC.profileIndex == null) await resolveProfile();
  let r = await supaReq('GET', `/rest/v1/collections?select=collections_json&profile_id=eq.${ACC.profileIndex}&limit=1`, null, tok);
  let rows = Array.isArray(r.json) ? r.json : [];
  if (!rows.length) { r = await supaReq('GET', '/rest/v1/collections?select=collections_json&limit=1', null, tok); rows = Array.isArray(r.json) ? r.json : []; }
  return rows.length ? (rows[0].collections_json || []) : [];
}
async function getHomeRows() {
  const tok = await userToken(); if (!tok) throw new Error('sin sesión');
  if (ACC.profileIndex == null) await resolveProfile();
  let r = await supaReq('GET', `/rest/v1/home_catalog_settings?select=settings_json&profile_id=eq.${ACC.profileIndex}&limit=1`, null, tok);
  let rowsArr = Array.isArray(r.json) ? r.json : [];
  if (!rowsArr.length) { r = await supaReq('GET', '/rest/v1/home_catalog_settings?select=settings_json&limit=1', null, tok); rowsArr = Array.isArray(r.json) ? r.json : []; }
  const items = (rowsArr[0] && rowsArr[0].settings_json && rowsArr[0].settings_json.items) || [];
  const colls = await getCollectionsBlob().catch(() => []);
  const collById = {}; colls.forEach(c => { collById[c.id] = c; });
  const mc = await getAllManifests();
  const out = [];
  const referenced = {};
  for (const it of items) {
    if (!it || !it.enabled) continue;
    if (it.is_collection) {
      const cid = it.collection_id || String(it.key || '').replace(/^collection_/, '');
      const c = collById[cid]; if (!c) continue;
      out.push({ key: it.key || ('collection_' + cid), kind: 'collection', title: it.custom_title || c.title || 'Colección',
        collectionId: c.id, folders: (c.folders || []).length });
    } else {
      const key = String(it.key || '');
      const parts = key.split(':');
      if (parts.length < 3) continue;
      const type = parts[1], catalogId = parts.slice(2).join(':');
      const m = findManifest(mc, parts[0]);
      const cat = m ? (m.catalogs || []).find(c => String(c.id) === catalogId && String(c.type || c.apiType) === type) : null;
      if (!m || !cat) continue;
      referenced[m.id] = 1;
      out.push({ key, kind: 'catalog', title: it.custom_title || cat.name || catalogId, addonId: m.id, addonName: m.name, type, catalogId });
    }
  }
  // Addons nuevos: si el addon está habilitado pero su fila no está en el layout
  // (o el layout quedó viejo), agregamos sus catálogos de deportes/TV igual.
  const LIVE_TYPES = { sport: 1, channel: 1, tv: 1 };
  const extra = [];
  const seen = {};
  for (const row of out) seen[row.key] = 1;
  for (const m of mc.list) {
    if (referenced[m.id]) continue;
    const live = (m.catalogs || []).filter(c => LIVE_TYPES[String(c.type || c.apiType)]);
    if (!live.length) continue;
    const prio = c => {
      const t = String(c.id || '') + ' ' + String(c.name || '');
      if (/live|now|en vivo|ao vivo/i.test(t)) return 0;
      if (/24\/7|networks/i.test(t)) return 1;
      if (/today|yesterday|this_week|older|recent/i.test(t)) return 4;
      if (/replays?$/i.test(String(c.id || ''))) return 2;
      return 3;
    };
    const ordered = live.map((c, i) => ({ c, i })).sort((a, b) => (prio(a.c) - prio(b.c)) || (a.i - b.i)).map(x => x.c);
    let n = 0;
    for (const c of ordered) {
      const type = String(c.type || c.apiType);
      const key = m.id + ':' + type + ':' + c.id;
      if (seen[key] || n >= 10) continue;
      seen[key] = 1; n++;
      extra.push({ key, kind: 'catalog', title: String(cleanEmoji(c.name || c.id) || '').trim(), addonId: m.id, addonName: m.name, type, catalogId: c.id });
    }
  }
  if (extra.length) {
    let at = -1;
    for (let i = 0; i < out.length; i++) if (LIVE_TYPES[out[i].type]) at = i;
    out.splice(at + 1, 0, ...extra);
  }
  return { rows: out };
}
async function fetchAddonCatalog(addonId, type, catalogId, genre, skip, page) {
  const mc = await getAllManifests();
  const m = findManifest(mc, addonId);
  if (!m) throw new Error('addon no encontrado: ' + addonId);
  const extras = [];
  if (genre && genre !== 'None') extras.push('genre=' + encodeURIComponent(genre));
  if (skip) extras.push('skip=' + encodeURIComponent(skip));
  if (page) extras.push('page=' + encodeURIComponent(page));
  const url = m.base + '/catalog/' + type + '/' + catalogId + (extras.length ? '/' + extras.join('&') : '') + '.json';
  const j = await withTimeout(getJSON(url), 25000, m.name);
  const metas = (j && j.metas) || [];
  return metas.map(x => ({
    id: String(x.id || ''),
    type: nativeType(x.type, type),
    title: String(cleanEmoji(x.name || x.title || '') || '').trim(),
    poster: x.poster || x.landscapePoster || '',
    background: x.background || '',
    logo: x.logo || '',
    posterShape: x.posterShape || '',
    year: x.releaseInfo ? String(x.releaseInfo).slice(0, 4) : '',
    rating: x.imdbRating || null
  })).filter(x => x.id && x.title);
}
async function fetchTmdbSource(source, page) {
  const type = String(source.tmdbSourceType || '').toUpperCase();
  const mt = (type === 'NETWORK' || String(source.mediaType || 'MOVIE').toUpperCase() === 'TV') ? 'tv' : 'movie';
  const q = new URLSearchParams();
  q.set('api_key', TMDB_KEY); q.set('language', LANG); q.set('page', String(page || 1));
  q.set('sort_by', source.sortBy || (mt === 'tv' ? 'first_air_date.desc' : 'popularity.desc'));
  const f = source.filters || {};
  const setIf = (k, v) => { if (v != null && v !== '') q.set(k, v); };
  setIf('with_genres', f.withGenres); setIf('without_genres', f.withoutGenres);
  setIf(mt === 'tv' ? 'first_air_date.gte' : 'primary_release_date.gte', f.releaseDateGte);
  setIf(mt === 'tv' ? 'first_air_date.lte' : 'primary_release_date.lte', f.releaseDateLte);
  setIf('vote_average.gte', f.voteAverageGte); setIf('vote_average.lte', f.voteAverageLte);
  setIf('vote_count.gte', f.voteCountGte);
  setIf('with_original_language', f.withOriginalLanguage); setIf('with_origin_country', f.withOriginCountry);
  setIf('with_keywords', f.withKeywords); setIf('without_keywords', f.withoutKeywords);
  setIf(mt === 'movie' ? 'primary_release_year' : 'first_air_date_year', f.year);
  setIf('watch_region', f.watchRegion); setIf('with_watch_providers', f.withWatchProviders);
  setIf('with_networks', f.withNetworks); setIf('with_companies', f.withCompanies);
  if (type === 'COMPANY' && source.tmdbId) q.set('with_companies', String(source.tmdbId));
  if (type === 'NETWORK' && source.tmdbId) {
    q.set('with_networks', String(source.tmdbId));
    if (!f.releaseDateLte) q.set('first_air_date.lte', new Date().toISOString().slice(0, 10));
    q.set('with_status', '0|3|4');
  }
  const j = await withTimeout(getJSON(`${TMDB}/discover/${mt}?${q.toString()}`), 25000, 'tmdb');
  return (j.results || []).map(x => mapItem(x, mt));
}
// Stary WebKit TV nie ma czcionki emoji -> flagi na [PL]/[EN], resztę emoji usuń
function cleanEmoji(t) {
  if (!t) return t;
  t = String(t);
  // pary regional indicators (flagi) -> kod literowy w nawiasach: 🇵🇱 -> [PL]
  t = t.replace(/([\u{1F1E6}-\u{1F1FF}])([\u{1F1E6}-\u{1F1FF}])/gu, function (_, a, b) {
    var la = String.fromCharCode(65 + (a.codePointAt(0) - 0x1F1E6));
    var lb = String.fromCharCode(65 + (b.codePointAt(0) - 0x1F1E6));
    return '[' + la + lb + ']';
  });
  // usuń pozostałe emoji/symbole/piktogramy/variation-selectors/ZWJ
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{FE0F}\u{200D}\u{20E3}]/gu, '');
  // posprzątaj podwójne spacje / puste nawiasy po usunięciu
  t = t.replace(/\[\s*\]/g, '').replace(/[ \t]{2,}/g, ' ');
  return t;
}

function qualFromText(t) {
  t = String(t || '').toLowerCase();
  if (t.indexOf('2160') > -1 || t.indexOf('4k') > -1) return '2160p';
  if (t.indexOf('1080') > -1) return '1080p';
  if (t.indexOf('720') > -1) return '720p';
  if (t.indexOf('480') > -1) return '480p';
  return '';
}
const ADDON_STREAMS_CACHE = {};
async function addonStreams(type, tmdbId, season, episode) {
  const ck = type + '|' + tmdbId + '|' + (season || '') + '|' + (episode || '');
  const cc = ADDON_STREAMS_CACHE[ck];
  if (cc && Date.now() - cc.ts < 300000) return cc.data;
  const addons = await getUserAddons();
  const stType = (type === 'series' || type === 'tv') ? 'series' : 'movie';
  const imdb = await tmdbToImdb(tmdbId, stType === 'series' ? 'tv' : 'movie');
  if (!imdb) return [];
  const vid = stType === 'series' ? `${imdb}:${season}:${episode}` : imdb;
  const usable = addons.filter(a => a.resources.indexOf('stream') > -1 && (!a.types.length || a.types.indexOf(stType) > -1));
  const jobs = usable.map(async a => {
    try {
      const j = await withTimeout(getJSON(`${a.base}/stream/${stType}/${encodeURIComponent(vid)}.json`), 30000, a.name);
      return (j.streams || []).map(s => mapStreamItem(s, a)).filter(Boolean);
    } catch (e) { console.log('[addon-stream]', a.name, e.message); return []; }
  });
  const res = await Promise.all(jobs);
  const all = [].concat.apply([], res);
  if (all.length) ADDON_STREAMS_CACHE[ck] = { ts: Date.now(), data: all };
  return all;
}

// --- ranking de streams (calidad + seeds + mp4 + idioma) ---
function streamScore(s) {
  let sc = 0;
  const q = s.quality || '';
  if (q === '2160p') sc += 400; else if (q === '1080p') sc += 300; else if (q === '720p') sc += 120; else if (q === '480p') sc += 20;
  const d = (s.desc || '') + ' ' + (s.title || '') + ' ' + (s.fn || '');
  const sd = d.match(/👤\s*(\d+)/); if (sd) sc += Math.min(120, parseInt(sd[1], 10));
  if (/\.mp4\b|\bmp4\b/i.test(d)) sc += 60;
  if (/yify|psa\b|rarbg/i.test(d)) sc += 25;
  if (/(\beng\b|english|🇬🇧|🇺🇸|🇨🇦|🇦🇺|multi|dual)/i.test(d)) sc += 40;
  if (/(latino|castellano|dublado|dubbed|\bdub\b|espanol|espa\u00f1ol|🇪🇸|🇧🇷|🇵🇹|🇷🇺|🇺🇦|🇵🇱|lektor|hindi|dubbing)/i.test(d)) sc -= 35;
  if (/[Ѐ-ӿ]{4,}/.test(s.title || '')) sc -= 30;   // tytuły cyrylicą (rosyjskie dubbingi)
  if (s.kind === 'direct') sc += 10;
  return sc;
}

// --- Torrents (webtorrent): streaming z /api/torrent ---
const TORR_DIR = path.join(process.env.HOME || '.', 'nuvio-bridge', 'torrents');
// trackers públicos por defecto (los addons tipo Torrentio NO mandan trackers: sin esto no hay peers)
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'https://tracker.tamersunion.org:443/announce'
];
function magnetWithTrackers(hash, dn, trackers) {
  let m = 'magnet:?xt=urn:btih:' + hash + '&dn=' + encodeURIComponent(dn || 'video');
  const all = (trackers || []).concat(DEFAULT_TRACKERS);
  const seen = {};
  for (let i = 0; i < all.length; i++) { if (all[i] && !seen[all[i]]) { seen[all[i]] = 1; m += '&tr=' + encodeURIComponent(all[i]); } }
  return m;
}
let WT = null, WT_P = null;
function getWT() {
  if (WT) return Promise.resolve(WT);
  if (WT_P) return WT_P;
  WT_P = import('webtorrent').then(m => {
    const WebTorrent = (m && (m.default || m));
    WT = new WebTorrent({ maxConns: 80, dht: true });
    WT.on('error', e => console.log('[wt]', e && e.message));
    console.log('[wt] webtorrent listo');
    return WT;
  }).catch(e => { WT_P = null; throw e; });
  return WT_P;
}
const TORR = {};       // hash -> { t, last }
const TORR_PEND = {};  // hash -> Promise
function torrentEnsure(hash, magnet) {
  if (magnet.indexOf('&tr=') < 0) magnet = magnetWithTrackers(hash, '', []);   // sin trackers no hay peers
  if (TORR[hash] && TORR[hash].t && (TORR[hash].t.metadata || TORR[hash].t.ready)) return Promise.resolve(TORR[hash].t);
  if (TORR_PEND[hash]) return TORR_PEND[hash];
  TORR_PEND[hash] = (async () => {
    const wt = await getWT();
    let t = null;
    try {
      const found = await wt.get(hash);           // v3: get() es async
      if (found && typeof found.once === 'function') t = found;
    } catch (e) {}
    if (!t) {
      fs.mkdirSync(TORR_DIR, { recursive: true });
      t = wt.add(magnet, { path: TORR_DIR });
    }
    if (!t || typeof t.once !== 'function') throw new Error('webtorrent: no se pudo agregar el torrent');
    TORR[hash] = { t: t, last: Date.now() };
    if (t.metadata || t.ready) return t;
    await new Promise((ok, bad) => {
      const to = setTimeout(() => bad(new Error('metadata timeout (poucos seeders?)')), 60000);
      t.once('metadata', () => { clearTimeout(to); ok(); });
      t.once('error', e => { clearTimeout(to); bad(e); });
    });
    return t;
  })();
  TORR_PEND[hash].then(() => { delete TORR_PEND[hash]; }, () => { delete TORR_PEND[hash]; });
  return TORR_PEND[hash];
}
function torrentTouch(h) { if (TORR[h]) TORR[h].last = Date.now(); }
function pickTorrentFile(t, ix, fn) {
  if (ix != null && t.files[ix]) return t.files[ix];
  if (fn) {
    const lf = String(fn).toLowerCase();
    let f = t.files.find(x => x.name.toLowerCase() === lf || String(x.path || '').toLowerCase().endsWith(lf));
    if (f) return f;
    const ep = lf.match(/[sS](\d{1,2})[eE](\d{1,2})/);
    if (ep) {
      const pat = new RegExp('[sS]0*' + parseInt(ep[1], 10) + '[eE]0*' + parseInt(ep[2], 10));
      f = t.files.filter(x => pat.test(x.name)).sort((a, b) => b.length - a.length)[0];
      if (f) return f;
    }
  }
  const vids = t.files.filter(x => /\.(mp4|mkv|avi|mov|m4v|webm|ts)$/i.test(x.name));
  const cand = (vids.length ? vids : t.files).slice().sort((a, b) => b.length - a.length);
  return cand[0] || null;
}
const MIME_BY_EXT = { mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', avi: 'video/x-msvideo', mov: 'video/quicktime', webm: 'video/webm', ts: 'video/mp2t', srt: 'application/x-subrip', vtt: 'text/vtt' };
function mimeByName(n) { const m = String(n || '').toLowerCase().match(/\.([a-z0-9]+)$/); return (m && MIME_BY_EXT[m[1]]) || 'application/octet-stream'; }
function streamTorrentFile(t, file, req, res) {
  const size = file.length;
  const range = req.headers.range;
  let start = 0, end = size - 1, code = 200;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m && (m[1] !== '' || m[2] !== '')) {
      code = 206;
      start = m[1] !== '' ? parseInt(m[1], 10) : Math.max(0, size - parseInt(m[2], 10));
      end = m[2] !== '' ? parseInt(m[2], 10) : size - 1;
      if (end >= size) end = size - 1;
    }
  }
  if (start >= size || start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + size }); return res.end(); }
  const headers = { 'Content-Type': mimeByName(file.name), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
  if (code === 206) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
  headers['Content-Length'] = String(end - start + 1);
  res.writeHead(code, headers);
  const stream = file.createReadStream({ start: start, end: end });
  let done = false;
  const fin = () => { if (done) return; done = true; try { stream.destroy(); } catch (e) {} };
  res.on('close', fin); res.on('error', fin);
  stream.on('error', e => { console.log('[torrent] stream err', e && e.message); try { res.destroy(); } catch (x) {} });
  stream.pipe(res);
}
// limpieza de torrents inactivos > 15 min
setInterval(() => {
  const now = Date.now();
  Object.keys(TORR).forEach(h => {
    const e = TORR[h];
    if (!e || !e.last || now - e.last > 15 * 60000) {
      try { e && e.t && e.t.destroy({ destroyStore: true }); } catch (x) {}
      delete TORR[h];
      console.log('[torrent] cleanup', h);
    }
  });
}, 5 * 60000);

// Napisy z addonów Stremio (np. OpenSubtitles v3) — protokół subtitles
async function addonSubtitles(type, tmdbId, season, episode) {
  const addons = await getUserAddons();
  const stType = (type === 'series' || type === 'tv') ? 'series' : 'movie';
  const imdb = await tmdbToImdb(tmdbId, stType === 'series' ? 'tv' : 'movie');
  if (!imdb) return [];
  const vid = stType === 'series' ? `${imdb}:${season}:${episode}` : imdb;
  const usable = addons.filter(a => a.resources.indexOf('subtitles') > -1);
  const jobs = usable.map(async a => {
    try {
      const j = await withTimeout(getJSON(`${a.base}/subtitles/${stType}/${encodeURIComponent(vid)}.json`), 15000, a.name);
      return (j.subtitles || []).filter(s => s.url).map(s => ({ lang: (s.lang || s.language || '?'), url: s.url, id: s.id || '' }));
    } catch (e) { return []; }
  });
  const res = await Promise.all(jobs);
  let all = [].concat.apply([], res);
  // prioridad: español, luego portugués, luego inglés
  const rank = l => { l = String(l).toLowerCase(); if (l.indexOf('spa') > -1 || l === 'es' || l.indexOf('esp') > -1) return 0; if (l.indexOf('por') > -1 || l === 'pt' || l.indexOf('pob') > -1) return 1; if (l.indexOf('eng') > -1 || l === 'en') return 2; return 3; };
  all.sort((a, b) => rank(a.lang) - rank(b.lang));
  // dedup po lang+url
  const seen = {}, out = [];
  for (const s of all) { const k = s.lang + '|' + s.url; if (!seen[k]) { seen[k] = 1; out.push(s); } }
  return out.slice(0, 25);
}

// Sprawdź czy link to realne wideo (a nie strona logowania/HTML) — pobierz nagłówki i przerwij.
function probeStream(streamUrl, hdrs) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    let target = streamUrl, hops = 0;
    function go(t) {
      let url; try { url = new URL(t); } catch (e) { return finish({ ok: false }); }
      const lib = t.indexOf('https') === 0 ? https : http;
      const headers = Object.assign({ 'User-Agent': 'Mozilla/5.0 (SmartTV; Tizen) AppleWebKit/538.1', 'Range': 'bytes=0-1' }, hdrs || {});
      const rq = lib.request({ method: 'GET', hostname: url.hostname, path: url.pathname + url.search, headers }, resp => {
        if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location && hops < 5) {
          hops++; resp.destroy(); return go(new URL(resp.headers.location, t).toString());
        }
        const ct = (resp.headers['content-type'] || '').toLowerCase();
        const ok = (resp.statusCode === 200 || resp.statusCode === 206) &&
          (ct.indexOf('video') > -1 || ct.indexOf('mpegurl') > -1 || ct.indexOf('octet-stream') > -1 || ct.indexOf('matroska') > -1 || ct.indexOf('mp4') > -1);
        resp.destroy();
        finish({ ok: ok, ctype: ct });
      });
      rq.on('error', () => finish({ ok: false }));
      rq.setTimeout(9000, () => { rq.destroy(); finish({ ok: false }); });
      rq.end();
    }
    go(target);
  });
}

function tvScore(s) {
  const q = String(s.quality || '').toLowerCase();
  const t = String(s.title || '').toLowerCase();
  let score = 0;
  // format przyjazny staremu TV
  if (t.indexOf('.mp4') > -1 || (s.ctype && s.ctype.indexOf('mp4') > -1)) score += 30;
  else if (s.ctype && s.ctype.indexOf('mpegurl') > -1) score += 22;
  else if (t.indexOf('.mkv') > -1 || (s.ctype && s.ctype.indexOf('matroska') > -1)) score += 18;
  else score += 10;
  // rozdzielczość: 1080/720 najlepsze, 4K słabo (TV to panel 1080 + brak HEVC)
  if (q.indexOf('1080') > -1) score += 20;
  else if (q.indexOf('720') > -1) score += 16;
  else if (q.indexOf('480') > -1) score += 8;
  else if (q.indexOf('2160') > -1 || q.indexOf('4k') > -1) score += 4;
  else score += 10;
  // HEVC/x265 kiepsko dekoduje na J-series
  if (t.indexOf('265') > -1 || t.indexOf('hevc') > -1) score -= 10;
  // Twoje własne addony Nuvio (AIOStreams itd.) mają priorytet nad zapasowymi providerami
  if (s._addon) score += 40;
  return score;
}

// ---------- Agregacja streamów ----------
async function gatherStreams(type, tmdbId, season, episode) {
  const mediaType = type === 'series' || type === 'tv' ? 'tv' : 'movie';
  const usable = PROVIDERS.filter(p => p.supportedTypes.indexOf(mediaType) !== -1);
  const jobs = usable.map(p =>
    withTimeout(Promise.resolve().then(() =>
      p.mod.getStreams(String(tmdbId), mediaType, season != null ? Number(season) : null, episode != null ? Number(episode) : null)
    ), STREAM_TIMEOUT, p.id)
      .then(list => (Array.isArray(list) ? list : []).map(s => Object.assign({ provider: p.name }, s)))
      .catch(e => { console.log('[stream]', p.id, 'błąd:', e.message); return []; })
  );
  const results = await Promise.all(jobs);
  const flat = [].concat.apply([], results).filter(s => s && s.url);
  const rank = q => { q = String(q || '').toLowerCase(); if (q.indexOf('2160') > -1 || q.indexOf('4k') > -1) return 4; if (q.indexOf('1080') > -1) return 3; if (q.indexOf('720') > -1) return 2; if (q.indexOf('cam') > -1) return 0; return 1; };
  flat.sort((a, b) => rank(b.quality) - rank(a.quality));
  return flat;
}

// ---------- Mapowanie TMDB -> proste obiekty dla TV ----------
function poster(p) { return p ? IMG + '/w342' + p : ''; }
function backdrop(p) { return p ? IMG + '/w780' + p : ''; }
function mapItem(x, forcedType) {
  const type = forcedType || x.media_type || (x.title ? 'movie' : 'tv');
  return {
    id: x.id,
    type: type === 'tv' ? 'series' : 'movie',
    title: x.title || x.name || '',
    year: (x.release_date || x.first_air_date || '').slice(0, 4),
    poster: poster(x.poster_path),
    rating: x.vote_average ? Math.round(x.vote_average * 10) / 10 : null
  };
}

// ---------- Router ----------
const CATEGORIES = {
  'trending-movie': `${TMDB}/trending/movie/week`,
  'trending-tv': `${TMDB}/trending/tv/week`,
  'popular-movie': `${TMDB}/movie/popular`,
  'top-movie': `${TMDB}/movie/top_rated`,
  'popular-tv': `${TMDB}/tv/popular`,
  'top-tv': `${TMDB}/tv/top_rated`
};

function send(res, code, obj, headers) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, Object.assign({
    'Content-Type': typeof obj === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  }, headers || {}));
  res.end(body);
}

function buildStreamOut(req, list) {
  const host = req.headers.host;
  return list.map(s => {
    let playUrl;
    if (s.kind === 'torrent') {
      playUrl = `http://${host}/api/torrent?m=${encodeURIComponent(s.magnet)}` + (s.fileIdx != null ? `&ix=${s.fileIdx}` : '') + (s.fn ? `&fn=${encodeURIComponent(s.fn)}` : '');
    } else if (s.url) {
      const h = (s.headers && Object.keys(s.headers).length) ? Buffer.from(JSON.stringify(s.headers)).toString('base64') : '';
      const isHls = !!s.hls || /\.m3u8(\?|$)/i.test(s.url) || /\.m3u8(\?|$)/i.test(String(s.direct || ''));
      playUrl = `http://${host}/api/proxy?u=${encodeURIComponent(s.url)}` + (isHls ? '&hls=1' : '') + (h ? `&h=${encodeURIComponent(h)}` : '');
    } else {
      playUrl = s.externalUrl || '';
    }
    return {
      provider: cleanEmoji(s.provider || s.name || ''),
      title: cleanEmoji(s.title || s.name || 'Stream'),
      desc: cleanEmoji(s.desc || ''),
      size: s.size || null,
      quality: s.quality || '',
      kind: s.kind || 'direct',
      hls: !!s.hls,
      live: !!s.live,
      url: playUrl,
      direct: s.url || s.magnet || ''
    };
  });
}

async function handleApi(req, res, u) {
  const parts = u.pathname.split('/').filter(Boolean); // ['api', ...]
  const seg = parts.slice(1);

  // /api/log?t= -> beacon diagnostyczny z telewizora
  if (seg[0] === 'log') {
    console.log('[TVLOG] ' + (u.searchParams.get('t') || ''));
    return send(res, 200, '');
  }

  // /api/health
  if (seg[0] === 'health') return send(res, 200, { ok: true, providers: PROVIDERS.map(p => p.id) });

  // /api/reload  -> przeładuj providery
  if (seg[0] === 'reload') { await loadProviders(); return send(res, 200, { ok: true, providers: PROVIDERS.length }); }

  // /api/catalog/:category
  if (seg[0] === 'catalog') {
    const cat = seg[1];
    const url = CATEGORIES[cat];
    if (!url) return send(res, 404, { error: 'nieznana kategoria' });
    const forced = cat.indexOf('tv') > -1 ? 'tv' : 'movie';
    const j = await getJSON(`${url}?api_key=${TMDB_KEY}&language=${LANG}`);
    return send(res, 200, { items: (j.results || []).map(x => mapItem(x, forced)) });
  }

  // /api/search?q=
  if (seg[0] === 'search') {
    const q = u.searchParams.get('q') || '';
    const j = await getJSON(`${TMDB}/search/multi?api_key=${TMDB_KEY}&language=${LANG}&query=${encodeURIComponent(q)}`);
    const items = (j.results || []).filter(x => x.media_type === 'movie' || x.media_type === 'tv').map(x => mapItem(x));
    return send(res, 200, { items });
  }

  // /api/meta/:type/:id  (TMDB para movie/series; meta del addon para channel/sport/collection/tv/anime y fallback)
  if (seg[0] === 'meta') {
    const reqType = String(seg[1] || '').toLowerCase();
    const rawId = decodeURIComponent(seg[2] || '');
    if (reqType !== 'movie' && reqType !== 'series') {
      const am = await fetchAddonMeta(reqType, rawId);
      if (!am) return send(res, 404, { error: 'meta no encontrada: ' + reqType + '/' + rawId });
      return send(res, 200, am);
    }
    let type = reqType === 'series' ? 'tv' : 'movie';
    let id = rawId;
    try {
    if (/^tt\d+$/i.test(id)) {
      const f = await getJSON(`${TMDB}/find/${id}?api_key=${TMDB_KEY}&external_source=imdb_id&language=${LANG}`);
      const mv = (f.movie_results || [])[0], tv = (f.tv_results || [])[0];
      const hit = (type === 'tv' ? (tv || mv) : (mv || tv));
      if (!hit) return send(res, 404, { error: 'no encontrado para ' + id });
      id = hit.id;
      if (!mv && tv) type = 'tv'; else if (!tv && mv) type = 'movie';
    } else if (/^tmdb:/i.test(id)) { id = id.split(':')[1]; }
    const j = await getJSON(`${TMDB}/${type}/${id}?api_key=${TMDB_KEY}&language=${LANG}`);
    const meta = {
      id: j.id, type: type === 'tv' ? 'series' : 'movie', title: j.title || j.name || '',
      overview: j.overview || '',
      year: (j.release_date || j.first_air_date || '').slice(0, 4),
      poster: poster(j.poster_path), backdrop: backdrop(j.backdrop_path),
      rating: j.vote_average ? Math.round(j.vote_average * 10) / 10 : null,
      imdb: j.imdb_id || (j.external_ids && j.external_ids.imdb_id) || null,
      runtime: j.runtime || (j.episode_run_time && j.episode_run_time[0]) || null,
      genres: (j.genres || []).map(g => g.name)
    };
    if (type === 'tv') {
      meta.seasons = (j.seasons || []).filter(s => s.season_number > 0)
        .map(s => ({ season: s.season_number, name: s.name, episodes: s.episode_count }));
    }
    return send(res, 200, meta);
    } catch (e) {
      const am = await fetchAddonMeta(reqType, rawId);
      if (am) return send(res, 200, am);
      throw e;
    }
  }

  // /api/episodes/:id/:season
  if (seg[0] === 'episodes') {
    const id = decodeURIComponent(seg[1] || ''), season = seg[2];
    const cached = ADDON_META_CACHE['series|' + id] || ADDON_META_CACHE['tv|' + id];
    if (cached && cached.data && cached.data._episodes) {
      return send(res, 200, { season: Number(season), episodes: cached.data._episodes[season] || [] });
    }
    const j = await getJSON(`${TMDB}/tv/${id}/season/${season}?api_key=${TMDB_KEY}&language=${LANG}`);
    const eps = (j.episodes || []).map(e => ({
      episode: e.episode_number, name: e.name || ('Odcinek ' + e.episode_number),
      overview: e.overview || '', still: e.still_path ? IMG + '/w300' + e.still_path : ''
    }));
    return send(res, 200, { season: Number(season), episodes: eps });
  }

  // /api/home -> filas del hogar (colecciones + catálogos habilitados de la cuenta)
  if (seg[0] === 'home') {
    const h = await getHomeRows();
    return send(res, 200, h);
  }

  // /api/row?key=&genre=&skip=  -> items de una fila-catálogo
  if (seg[0] === 'row') {
    const key = u.searchParams.get('key') || '';
    const parts = key.split(':');
    if (parts.length < 3) return send(res, 400, { error: 'key inválida' });
    const items = await fetchAddonCatalog(parts[0], parts[1], parts.slice(2).join(':'), u.searchParams.get('genre'), u.searchParams.get('skip'), u.searchParams.get('page'));
    return send(res, 200, { items });
  }

  // /api/collection?id=  -> carpeta de una colección (folders)
  if (seg[0] === 'collection') {
    const cid = u.searchParams.get('id');
    const colls = await getCollectionsBlob();
    const c = colls.find(x => x.id === cid);
    if (!c) return send(res, 404, { error: 'colección no encontrada' });
    const folders = (c.folders || []).map(f => ({
      id: f.id, title: f.title, coverImageUrl: f.coverImageUrl || null,
      titleLogoUrl: f.titleLogoUrl || null, focusGifUrl: f.focusGifUrl || null,
      tileShape: f.tileShape || 'LANDSCAPE', hideTitle: !!f.hideTitle
    }));
    return send(res, 200, { id: c.id, title: c.title, viewMode: c.viewMode || '', folders });
  }

  // /api/folder?cid=&fid=  -> tabs (sources) de la carpeta
  if (seg[0] === 'folder') {
    const colls = await getCollectionsBlob();
    const c = colls.find(x => x.id === u.searchParams.get('cid'));
    const f = c && (c.folders || []).find(x => x.id === u.searchParams.get('fid'));
    if (!f) return send(res, 404, { error: 'carpeta no encontrada' });
    const mc = await getAllManifests();
    const tabs = [];
    (f.sources || []).forEach((s, i) => {
      if (s.provider === 'tmdb') {
        tabs.push({ i, kind: 'tmdb', title: s.title || s.tmdbSourceType || 'TMDB',
          tmdbSourceType: s.tmdbSourceType, tmdbId: s.tmdbId, mediaType: s.mediaType || 'MOVIE',
          sortBy: s.sortBy || '', filters: s.filters || {} });
      } else if ((s.provider || 'addon') === 'addon') {
        const m = findManifest(mc, s.addonId);
        const cat = m ? (m.catalogs || []).find(c2 => String(c2.id) === String(s.catalogId) && String(c2.type || c2.apiType) === String(s.type)) : null;
        const baseName = (cat && cat.name) || s.catalogName || s.title || s.catalogId;
        tabs.push({ i, kind: 'addon', title: (s.genre && s.genre !== 'None') ? (baseName + ' · ' + s.genre) : baseName,
          addonId: s.addonId, catalogId: s.catalogId, type: s.type, genre: s.genre || '' });
      }
    });
    return send(res, 200, { folder: { id: f.id, title: f.title, coverImageUrl: f.coverImageUrl || null,
      heroBackdropUrl: f.heroBackdropUrl || null, titleLogoUrl: f.titleLogoUrl || null }, tabs });
  }

  // /api/folderitems?cid=&fid=&tab=&skip=&page=  -> items de un tab de la carpeta
  if (seg[0] === 'folderitems') {
    const colls = await getCollectionsBlob();
    const c = colls.find(x => x.id === u.searchParams.get('cid'));
    const f = c && (c.folders || []).find(x => x.id === u.searchParams.get('fid'));
    if (!f) return send(res, 404, { error: 'carpeta no encontrada' });
    const s = (f.sources || [])[Number(u.searchParams.get('tab') || 0)];
    if (!s) return send(res, 404, { error: 'tab no existe' });
    let items;
    if (s.provider === 'tmdb') items = await fetchTmdbSource(s, Number(u.searchParams.get('page') || 1));
    else items = await fetchAddonCatalog(s.addonId, s.type, s.catalogId, s.genre, u.searchParams.get('skip') || '0');
    return send(res, 200, { items });
  }

  // /api/streams/:type/:id?season=&episode=
  if (seg[0] === 'streams') {
    const type = String(seg[1] || '').toLowerCase(), id = decodeURIComponent(seg[2] || '');
    const season = u.searchParams.get('season');
    const episode = u.searchParams.get('episode');
    if (type !== 'movie' && type !== 'series') {
      const live = await fetchAddonStreamsNative(type, id).catch(e => { console.log('[live]', e.message); return []; });
      if (!live.length) return send(res, 200, { streams: [], live: true });
      live.sort((a, b) => (b.quality || '').localeCompare(a.quality || ''));
      return send(res, 200, { streams: buildStreamOut(req, live.slice(0, 40)), live: true });
    }
    // Streams z addonów Nuvio (AIOStreams/Torrentio/TorrentClaw...) + zapasowo providery (cap global 25s).
    const [fromAddons, fromProviders] = await Promise.all([
      addonStreams(type, id, season, episode).catch(() => []),
      withTimeout(gatherStreams(type, id, season, episode).catch(() => []), 25000, 'providers').catch(() => [])
    ]);
    let streams = fromAddons.filter(s => s.kind !== 'external');
    // dedupe: infohash / url / tytuł+kalita
    const seen = {}; streams = streams.filter(s => {
      const k = s.infoHash ? ('h:' + s.infoHash) : (s.url ? ('u:' + s.url) : ('t:' + s.title + '|' + s.quality));
      if (seen[k]) return false; seen[k] = 1; return true;
    });
    // ranking: jakość + seedery + mp4 + język (dubbingi na koniec)
    streams.sort((a, b) => streamScore(b) - streamScore(a));
    if (streams.length > 100) streams = streams.slice(0, 100);
    let prov = fromProviders;
    prov.sort((a, b) => tvScore(b) - tvScore(a));
    const toCheck = prov.slice(0, 12);
    const checks = await Promise.all(toCheck.map(s => probeStream(s.url, s.headers).then(r => { s.ctype = r.ctype; s._ok = r.ok; return s; })));
    let provOk = checks.filter(s => s._ok);
    if (!provOk.length) provOk = toCheck;
    provOk.sort((a, b) => tvScore(b) - tvScore(a));
    streams = streams.concat(provOk.map(s => { if (!s.kind) s.kind = 'direct'; return s; }));
    return send(res, 200, { streams: buildStreamOut(req, streams) });
  }

  // /api/torrent?m=<magnet>&ix=&fn= -> strumień torrenta (webtorrent, HTTP Range dla TV)
  if (seg[0] === 'torrent') {
    const magnet = u.searchParams.get('m') || '';
    const hm = magnet.match(/urn:btih:([a-fA-F0-9]{40})/i);
    if (!hm) return send(res, 400, { error: 'magnet inválido' });
    const hash = hm[1].toLowerCase();
    const ixS = u.searchParams.get('ix');
    const fn = u.searchParams.get('fn') || '';
    try {
      const t = await torrentEnsure(hash, magnet);
      const file = pickTorrentFile(t, (ixS != null && ixS !== '') ? parseInt(ixS, 10) : null, fn);
      if (!file) return send(res, 404, { error: 'archivo no encontrado en el torrent' });
      torrentTouch(hash);
      console.log('[torrent]', hash.slice(0, 10), '->', file.name.slice(0, 60), (file.length / 1048576).toFixed(0) + 'MB', 'peers:', t.numPeers);
      return streamTorrentFile(t, file, req, res);
    } catch (e) {
      return send(res, 504, { error: 'torrent: ' + e.message });
    }
  }

  // /api/subtitles/:type/:id?season=&episode=  -> napisy z addonów usera, URL przez proxy
  if (seg[0] === 'subtitles') {
    const type = seg[1], id = decodeURIComponent(seg[2] || '');
    const season = u.searchParams.get('season'), episode = u.searchParams.get('episode');
    const subs = await addonSubtitles(type, id, season, episode);
    const host = req.headers.host;
    const out = subs.map(s => ({ lang: s.lang, url: `http://${host}/api/proxy?u=${encodeURIComponent(s.url)}`, direct: s.url }));
    return send(res, 200, { subtitles: out });
  }

  // /api/proxy?u=&h=  -> przepuszcza strumień z nagłówkami
  if (seg[0] === 'proxy') {
    const target = u.searchParams.get('u');
    if (!target) return send(res, 400, { error: 'brak u' });
    let headers = {};
    const hb = u.searchParams.get('h');
    if (hb) { try { headers = JSON.parse(Buffer.from(hb, 'base64').toString('utf8')); } catch (e) {} }
    if (req.headers.range) headers['Range'] = req.headers.range;
    if (!headers['User-Agent'] && !headers['user-agent']) headers['User-Agent'] = 'Mozilla/5.0 (SmartTV; Tizen) AppleWebKit/538.1';
    // Podążaj za przekierowaniami po stronie serwera (AVPlay bywa kapryśny przy 302); potem streamuj finalną odpowiedź.
    function fwd(tgt, hops) {
      if (hops > 6) { if (!res.headersSent) send(res, 508, { error: 'za dużo przekierowań' }); return; }
      const lib = tgt.startsWith('https') ? https : http;
      const preq = lib.request(tgt, { headers }, pres => {
        if (pres.statusCode >= 300 && pres.statusCode < 400 && pres.headers.location) {
          const loc = new URL(pres.headers.location, tgt).toString();
          pres.resume();
          return fwd(loc, hops + 1);
        }
        const hh = {};
        ['content-type', 'content-length', 'accept-ranges', 'content-range'].forEach(k => { if (pres.headers[k]) hh[k] = pres.headers[k]; });
        hh['Access-Control-Allow-Origin'] = '*';
        if (u.searchParams.get('hls') === '1' || /\.m3u8(\?|$)/i.test(tgt)) {
          const chunks = []; let size = 0;
          pres.on('data', c => { if (size < 8 * 1048576) { chunks.push(c); size += c.length; } });
          pres.on('end', () => {
            const buf = Buffer.concat(chunks);
            const head = buf.slice(0, 8).toString('utf8');
            delete hh['content-range']; delete hh['content-encoding'];
            if (head.indexOf('#EXTM3U') === 0) {
              const body = rewriteHls(buf.toString('utf8'), tgt, req.headers.host || ('localhost:' + PORT));
              if (!hh['content-type'] || hh['content-type'] === 'video/mp4') hh['content-type'] = 'application/vnd.apple.mpegurl';
              hh['content-length'] = Buffer.byteLength(body);
              res.writeHead(pres.statusCode, hh);
              res.end(body);
            } else {
              hh['content-length'] = buf.length;
              res.writeHead(pres.statusCode, hh);
              res.end(buf);
            }
          });
          return;
        }
        if (!hh['content-type']) hh['content-type'] = 'video/mp4';
        res.writeHead(pres.statusCode, hh);
        pres.pipe(res);
      });
      preq.on('error', e => { console.log('[proxy-vid] błąd', e.message); if (!res.headersSent) send(res, 502, { error: e.message }); });
      preq.setTimeout(30000, () => preq.destroy(new Error('timeout')));
      preq.end();
    }
    fwd(target, 0);
    return;
  }

  return send(res, 404, { error: 'not found' });
}

// ---------- Serwer + statyczny hosting (opcjonalny) ----------
// Wspólny proxy do dowolnego celu https (stary WebKit TV nie dogaduje nowoczesnego TLS)
function rewriteHls(body, baseUrl, host) {
  function prox(u) {
    try {
      const abs = new URL(u, baseUrl).toString();
      const hls = /\.m3u8(\?|$)/i.test(abs) || /[?&]m3u8=/.test(abs);
      return `http://${host}/api/proxy?u=${encodeURIComponent(abs)}` + (hls ? '&hls=1' : '');
    } catch (e) { return u; }
  }
  return String(body).split('\n').map(line => {
    const t = line.trim();
    if (!t) return line;
    if (t.charAt(0) === '#') return line.replace(/URI="([^"]+)"/g, (m, uri) => 'URI="' + prox(uri) + '"');
    return prox(t);
  }).join('\n');
}

function proxyTo(req, res, target, reqHost) {
  const headers = {};
  for (const k in req.headers) {
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'origin' || lk === 'referer' || lk === 'connection' || lk === 'accept-encoding') continue;
    headers[k] = req.headers[k];
  }
  let targetHost;
  try { targetHost = new URL(target).host; } catch (e) { return send(res, 400, 'zły url'); }
  headers['host'] = targetHost;
  const proxyBase = 'http://' + (reqHost || 'localhost:' + PORT) + '/img?u=';
  // hosty grafik których stary WebKit TV nie ładuje po HTTPS (TLS) — przepisujemy na proxy /img
  const IMGHOSTS = /https:\/\/(images\.metahub\.space|image\.tmdb\.org|[a-z0-9-]+\.tmdb\.org|[a-z0-9-]+\.qrserver\.com|live\.metahub\.space)\/[^"'\\ )]+/g;
  const preq = https.request(target, { method: req.method, headers }, pres => {
    const rh = {};
    for (const k in pres.headers) rh[k] = pres.headers[k];
    rh['access-control-allow-origin'] = '*';
    rh['access-control-allow-headers'] = '*';
    rh['access-control-allow-methods'] = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
    const ct = (pres.headers['content-type'] || '').toLowerCase();
    const wantHls = /[?&]hls=1(&|$)/.test(req.url || '');
    if (wantHls) {
      const chunks = []; let size = 0;
      pres.on('data', c => { if (size < 8 * 1048576) { chunks.push(c); size += c.length; } });
      pres.on('end', () => {
        const body = rewriteHls(Buffer.concat(chunks).toString('utf8'), target, reqHost);
        delete rh['content-length']; delete rh['content-encoding'];
        rh['content-length'] = Buffer.byteLength(body);
        res.writeHead(pres.statusCode, rh);
        res.end(body);
      });
      return;
    }
    if (/json|text|javascript/.test(ct)) {
      const chunks = [];
      pres.on('data', c => chunks.push(c));
      pres.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8');
        body = body.replace(IMGHOSTS, m => proxyBase + encodeURIComponent(m));
        delete rh['content-length'];
        delete rh['content-encoding'];
        rh['content-length'] = Buffer.byteLength(body);
        res.writeHead(pres.statusCode, rh);
        res.end(body);
      });
    } else {
      res.writeHead(pres.statusCode, rh);
      pres.pipe(res);
    }
  });
  preq.on('error', e => { console.log('[proxy] błąd', target, e.message); if (!res.headersSent) send(res, 502, { error: 'proxy: ' + e.message }); });
  req.pipe(preq);
}

const server = http.createServer((req, res) => {
  __route(req, res);
});
function __route(req, res) {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  console.log('[req]', req.socket.remoteAddress, req.method, u.pathname);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }
  const reqHost = req.headers.host || ('localhost:' + PORT);
  // /sb/* -> https://api.nuvio.tv/*  (backend konta Nuvio)
  if (u.pathname === '/sb' || u.pathname.startsWith('/sb/')) {
    const upstreamPath = u.pathname.slice(3) || '/';
    return proxyTo(req, res, SUPA + upstreamPath + (u.search || ''), reqHost);
  }
  // /px?u=<https url> -> generyczny proxy dla WSZYSTKICH żądań https z apki (dodatki Stremio itd.)
  if (u.pathname === '/px') {
    const tgt = u.searchParams.get('u');
    if (!tgt) return send(res, 400, 'brak u');
    return proxyTo(req, res, tgt, reqHost);
  }
  // /img?u=<https url> -> pobiera obrazek (dla hostów które stary TLS TV odrzuca, np. api.qrserver.com)
  if (u.pathname === '/img') {
    const tgt = u.searchParams.get('u');
    if (!tgt) return send(res, 400, 'brak u');
    httpGet(tgt).then(r => {
      res.writeHead(r.status, {
        'Content-Type': r.headers['content-type'] || 'image/png',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(r.body);
    }).catch(e => send(res, 502, 'img: ' + e.message));
    return;
  }
  // ---- Konto Nuvio: /me/* ----
  if (u.pathname.startsWith('/me/')) {
    const p = u.pathname.slice(4);
    const done = obj => send(res, 200, obj);
    const fail = e => { console.log('[me] błąd', p, e && e.message); send(res, 500, { error: e && e.message }); };
    if (p === 'status') { return userToken().then(t => done({ loggedIn: !!t, profile: ACC.profileName || null })).catch(fail); }
    if (p === 'login/start') { return loginStart().then(done).catch(fail); }
    if (p === 'login/poll') { return loginPoll().then(done).catch(fail); }
    if (p === 'logout') { ACC = { access: null, refresh: null, profileId: null }; saveSession(); return done({ ok: true }); }
    if (p === 'continue') { return getContinue().then(list => done({ items: list })).catch(fail); }
    if (p === 'delprogress') {
      return (async () => {
        const tok = await userToken(); if (ACC.profileIndex == null) await resolveProfile();
        const key = u.searchParams.get('key');
        const r = await supaReq('POST', '/rest/v1/rpc/sync_delete_watch_progress', { p_profile_id: ACC.profileIndex, p_keys: [key] }, tok);
        done({ status: r.status, body: r.json });
      })().catch(fail);
    }
    if (p === 'library' && req.method === 'GET') {
      return (async () => {
        const tok = await userToken(); if (!tok) return done({ items: [], offline: true });
        if (ACC.profileIndex == null) await resolveProfile();
        const rows = []; let offset = 0;
        while (true) {
          const r = await supaReq('POST', '/rest/v1/rpc/sync_pull_library', { p_profile_id: ACC.profileIndex, p_limit: 500, p_offset: offset }, tok);
          const page = Array.isArray(r.json) ? r.json : [];
          rows.push(...page);
          if (page.length < 500 || rows.length > 3000) break;
          offset += 500;
        }
        done({ items: rows.map(mapLibraryRow).filter(x => x.id) });
      })().catch(fail);
    }
    if (p === 'library' && req.method === 'POST') {
      return readJsonBody(req).then(async body => {
        const tok = await userToken(); if (!tok) return done({ ok: false, offline: true });
        if (ACC.profileIndex == null) await resolveProfile();
        const items = (body.items || []).filter(x => x && x.id).map(toLibraryRow);
        if (!items.length) return done({ ok: true, pushed: 0 });
        const r = await supaReq('POST', '/rest/v1/rpc/sync_push_library', { p_profile_id: ACC.profileIndex, p_items: items }, tok);
        done({ ok: r.status < 300, status: r.status, pushed: items.length });
      }).catch(fail);
    }
    if (p === 'watched' && req.method === 'GET') {
      return (async () => {
        const tok = await userToken(); if (!tok) return done({ items: [], offline: true });
        if (ACC.profileIndex == null) await resolveProfile();
        const rows = []; let page = 1;
        while (true) {
          const r = await supaReq('POST', '/rest/v1/rpc/sync_pull_watched_items', { p_profile_id: ACC.profileIndex, p_page: page, p_page_size: 900 }, tok);
          const pg = Array.isArray(r.json) ? r.json : [];
          rows.push(...pg);
          if (pg.length < 900 || page >= 6) break;
          page++;
        }
        done({ items: rows.map(mapWatchedRow).filter(x => x.id) });
      })().catch(fail);
    }
    if (p === 'watched' && req.method === 'POST') {
      return readJsonBody(req).then(async body => {
        const tok = await userToken(); if (!tok) return done({ ok: false, offline: true });
        if (ACC.profileIndex == null) await resolveProfile();
        const add = (body.add || []).filter(x => x && x.id).map(x => ({
          content_id: x.id, content_type: x.type || 'movie', title: x.title || '',
          season: x.season == null ? null : Number(x.season), episode: x.episode == null ? null : Number(x.episode),
          watched_at: Number(x.watchedAt) || Date.now()
        }));
        const remove = (body.remove || []).filter(x => x && x.id).map(x => {
          const k = { content_id: x.id };
          if (x.season != null) k.season = Number(x.season);
          if (x.episode != null) k.episode = Number(x.episode);
          return k;
        });
        let ok = true;
        if (add.length) { const r = await supaReq('POST', '/rest/v1/rpc/sync_push_watched_items', { p_profile_id: ACC.profileIndex, p_items: add }, tok); ok = ok && r.status < 300; }
        if (remove.length) { const r = await supaReq('POST', '/rest/v1/rpc/sync_delete_watched_items', { p_profile_id: ACC.profileIndex, p_keys: remove }, tok); ok = ok && r.status < 300; }
        done({ ok, added: add.length, removed: remove.length });
      }).catch(fail);
    }
    if (p === 'plugins') { return getUserPlugins().then(list => done({ plugins: list })).catch(fail); }
    if (p === 'tables') {
      return (async () => {
        const tok = await userToken();
        const names = ['plugins', 'addons', 'repositories', 'plugin_repositories', 'plugin_repos', 'repos',
          'sources', 'user_plugins', 'tv_plugins', 'installed_addons', 'home_catalog_settings',
          'profile_settings', 'saved_library', 'library_items', 'collections', 'catalogs'];
        const out = {};
        for (const t of names) {
          const r = await supaReq('GET', `/rest/v1/${t}?select=*&limit=5`, null, tok);
          out[t] = { status: r.status, count: Array.isArray(r.json) ? r.json.length : null,
            sample: Array.isArray(r.json) && r.json.length ? Object.keys(r.json[0]) : (r.json && r.json.code ? r.json.code : null) };
        }
        done(out);
      })().catch(fail);
    }
    if (p === 'plugdebug') {
      return (async () => {
        const tok = await userToken();
        const uid = jwtSub();
        const rpc1 = await supaReq('POST', '/rest/v1/rpc/sync_pull_plugins', { p_profile_id: ACC.profileIndex }, tok);
        const rpc0 = await supaReq('POST', '/rest/v1/rpc/sync_pull_plugins', {}, tok);
        const tbl = await supaReq('GET', '/rest/v1/plugins?select=*', null, tok);
        const tblProf = await supaReq('GET', `/rest/v1/plugins?profile_id=eq.${ACC.profileIndex}&select=*`, null, tok);
        const addons = await supaReq('POST', '/rest/v1/rpc/sync_pull_addons', { p_profile_id: ACC.profileIndex }, tok);
        done({
          profileIndex: ACC.profileIndex,
          rpc1_status: rpc1.status, rpc1: rpc1.json, rpc1_text: (rpc1.text || '').slice(0, 200),
          rpc0_status: rpc0.status, rpc0: rpc0.json,
          tbl_status: tbl.status, tbl: tbl.json, tbl_text: (tbl.text || '').slice(0, 200),
          tblProf_status: tblProf.status, tblProf: tblProf.json,
          addons_status: addons.status, addons: addons.json, addons_text: (addons.text || '').slice(0, 200)
        });
      })().catch(fail);
    }
    if (p === 'debug') {
      return (async () => {
        const tok = await userToken();
        const prof = await supaReq('POST', '/rest/v1/rpc/sync_pull_profiles', {}, tok);
        const wp = await supaReq('POST', '/rest/v1/rpc/sync_pull_watch_progress', { p_profile_id: ACC.profileId }, tok);
        const wpNoProfile = await supaReq('POST', '/rest/v1/rpc/sync_pull_watch_progress', {}, tok);
        done({
          profileId: ACC.profileId, sub: jwtSub(),
          profiles: prof.json, profilesStatus: prof.status,
          watchStatus: wp.status, watchRaw: wp.json, watchText: wp.text ? wp.text.slice(0, 300) : null,
          watchNoProfileStatus: wpNoProfile.status, watchNoProfileRaw: wpNoProfile.json
        });
      })().catch(fail);
    }
    if (p === 'progress' && req.method === 'POST') {
      const chunks = []; req.on('data', c => chunks.push(c));
      req.on('end', () => { let b = {}; try { b = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) {} pushProgress(b).then(ok => done({ ok })).catch(fail); });
      return;
    }
    return send(res, 404, { error: 'me: nieznane' });
  }
  if (u.pathname.startsWith('/api/')) {
    handleApi(req, res, u).catch(e => { console.log('[api] błąd', e); if (!res.headersSent) send(res, 500, { error: e.message }); });
    return;
  }
  send(res, 200, 'Nuvio Bridge działa. Użyj /api/health');
}

loadProviders().finally(() => {
  server.listen(PORT, () => console.log('[bridge] słucham na :' + PORT));
});
// odświeżaj providery co 6h
setInterval(() => loadProviders().catch(() => {}), 6 * 3600 * 1000);
