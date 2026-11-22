// Builds the animated album cover site that Apple Music Rich Presence uses.
//
//   1. Collects albums: Apple's official "most played albums" charts, the
//      albums people recently looked up on the public Apple Music Animated
//      Artworks site (https://artwork.m8tec.top), and any albums in
//      albums.txt (Apple Music links or "Artist - Album").
//   2. Asks the Apple Music Animated Artworks API
//      (https://github.com/m8tec/apple-music-animated-artworks, run locally as
//      a Docker service by the workflow) for each album's animated cover.
//      Albums from the public site already come with it.
//   3. Converts the cover video into a small, looping animated WebP with
//      ffmpeg, the same way https://github.com/m8tec/animated-artwork-downloader
//      does.
//   4. Writes site/index.json, which the app reads to find covers.
//
// Covers and results from earlier runs are restored from the Actions cache, so
// each album is only looked up and converted once. Covers for albums that are
// no longer in the list are dropped, which keeps the site small. Albums from
// the public site are kept for 30 days after they were last looked up there.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const env = process.env;

const config = {
  apiUrl: (env.ARTWORK_API_URL || 'http://localhost:8080').replace(/\/$/, ''),
  chartsUrl: env.CHARTS_URL || 'https://rss.marketingtools.apple.com/api/v2/{storefront}/music/most-played/{size}/albums.json',
  storefronts: (env.STOREFRONTS || 'us,gb').split(',').map((s) => s.trim()).filter(Boolean),
  chartSize: Number(env.CHART_SIZE || 100),
  historyUrl: env.HISTORY_URL ?? 'https://artwork.m8tec.top/api/v1/artwork/history',
  keepHistoryDays: Number(env.KEEP_HISTORY_DAYS || 30),
  albumsFile: env.ALBUMS_FILE || 'albums.txt',
  siteDir: env.SITE_DIR || 'site',
  stateFile: env.STATE_FILE || 'state/state.json',
  size: Number(env.COVER_SIZE || 320),
  fps: Number(env.COVER_FPS || 15),
  quality: Number(env.WEBP_QUALITY || 50),
  maxBytes: Number(env.MAX_COVER_BYTES || 4 * 1024 * 1024),
  delayMs: Number(env.DELAY_MS || 2000),
  recheckDays: Number(env.RECHECK_DAYS || 14),
  maxLookups: Number(env.MAX_LOOKUPS_PER_RUN || 150),
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const coversDir = path.join(config.siteDir, 'covers');

function albumId(url) {
  return String(url).match(/\/album\/(?:[^/?#]+\/)?(\d+)/)?.[1] || null;
}

// Albums without an Apple Music ID (added by name, or from the public site's
// history) get an ID made from their names; the app matches those by name.
function nameKey(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function nameId(artist, album) {
  return `n${createHash('sha1').update(`${nameKey(artist)}|${nameKey(album)}`).digest('hex').slice(0, 12)}`;
}

// `attempts` > 1 retries failures with a growing pause, for services that
// sometimes have a moment (Apple's chart feed has returned 502s).
async function fetchJson(url, attempts = 1) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`${url} returned ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await sleep(5000 * attempt);
    }
  }
}

// ------------------------------------------------------------------ albums

async function chartAlbums() {
  const albums = [];
  for (const storefront of config.storefronts) {
    const url = config.chartsUrl.replace('{storefront}', storefront).replace('{size}', config.chartSize);
    try {
      const data = await fetchJson(url, 4);
      for (const item of data?.feed?.results || []) {
        albums.push({ id: String(item.id), artist: item.artistName, album: item.name, url: item.url });
      }
      console.log(`Chart ${storefront}: ${data?.feed?.results?.length || 0} albums`);
    } catch (error) {
      console.warn(`Couldn't load the ${storefront} chart: ${error.message}`);
    }
  }
  return albums;
}

async function listedAlbums() {
  let text = '';
  try {
    text = await fs.readFile(config.albumsFile, 'utf8');
  } catch {
    return [];
  }
  const albums = [];
  for (const line of text.split('\n')) {
    const entry = line.replace(/#.*/, '').trim();
    if (!entry) continue;
    const id = albumId(entry);
    const separator = entry.indexOf(' - ');
    if (id) {
      // A link can be followed by its names, as in "<link>  # Artist - Album".
      const note = line.slice(line.indexOf('#') + 1).trim();
      const split = line.includes('#') ? note.indexOf(' - ') : -1;
      const names = split > 0 ? { artist: note.slice(0, split).trim(), album: note.slice(split + 3).trim() } : {};
      albums.push({ id, url: entry, ...names, source: 'listed' });
    } else if (separator > 0) {
      const artist = entry.slice(0, separator).trim();
      const album = entry.slice(separator + 3).trim();
      albums.push({ id: nameId(artist, album), artist, album, source: 'listed' });
    } else {
      console.warn(`albums.txt: expected an Apple Music album link or "Artist - Album": ${entry}`);
    }
  }
  return albums;
}

// The albums people recently looked up on the public Apple Music Animated
// Artworks site, with their animated cover's video already found.
async function historyAlbums() {
  if (!config.historyUrl) return [];
  try {
    const entries = (await fetchJson(config.historyUrl, 3)) || [];
    const albums = entries
      .filter((entry) => entry.url && entry.artist && entry.album)
      .map((entry) => ({
        id: nameId(entry.artist, entry.album),
        artist: entry.artist,
        album: entry.album,
        playlist: entry.url,
        source: 'history',
        lastSeen: new Date().toISOString(),
      }));
    console.log(`Recently looked up on ${new URL(config.historyUrl).host}: ${albums.length} albums`);
    return albums;
  } catch (error) {
    console.warn(`Couldn't load the recent lookups: ${error.message}`);
    return [];
  }
}

// ----------------------------------------------------------------- covers

// Picks the smallest video stream that's at least `size` wide, like the
// downloader does with its minimum resolution.
async function pickStream(playlistUrl) {
  if (!playlistUrl.includes('.m3u8')) return playlistUrl;
  const response = await fetch(playlistUrl, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`playlist returned ${response.status}`);
  const lines = (await response.text()).split('\n').map((line) => line.trim());

  const streams = [];
  lines.forEach((line, index) => {
    if (!line.startsWith('#EXT-X-STREAM-INF')) return;
    const [, width = 0] = line.match(/RESOLUTION=(\d+)x(\d+)/) || [];
    const uri = lines.slice(index + 1).find((next) => next && !next.startsWith('#'));
    if (uri) streams.push({ url: new URL(uri, playlistUrl).href, width: Number(width) });
  });
  if (!streams.length) return playlistUrl;

  const bigEnough = streams.filter((s) => s.width >= config.size).sort((a, b) => a.width - b.width);
  return (bigEnough[0] || streams.sort((a, b) => b.width - a.width)[0]).url;
}

async function convert(playlistUrl, outputFile) {
  const stream = await pickStream(playlistUrl);
  const tmpVideo = `${outputFile}.source.mp4`;
  const tmpWebp = `${outputFile}.tmp.webp`;
  try {
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', stream, '-map', '0:v:0', '-c', 'copy', '-an', tmpVideo], {
      timeout: 5 * 60 * 1000,
    });

    // Try smaller and lower quality versions until it fits the size limit.
    const attempts = [
      { size: config.size, fps: config.fps, quality: config.quality },
      { size: Math.round(config.size * 0.75), fps: config.fps, quality: Math.max(20, config.quality - 15) },
      { size: Math.round(config.size * 0.6), fps: Math.max(8, config.fps - 5), quality: Math.max(15, config.quality - 25) },
    ];
    for (const attempt of attempts) {
      const filter = `fps=${attempt.fps},scale=${attempt.size}:${attempt.size}:force_original_aspect_ratio=decrease:flags=lanczos`;
      await run(
        'ffmpeg',
        ['-y', '-loglevel', 'error', '-i', tmpVideo, '-vf', filter, '-c:v', 'libwebp', '-compression_level', '6',
          '-q:v', String(attempt.quality), '-loop', '0', '-an', tmpWebp],
        { timeout: 10 * 60 * 1000 }
      );
      const { size } = await fs.stat(tmpWebp);
      if (size <= config.maxBytes) {
        await fs.rename(tmpWebp, outputFile);
        return size;
      }
    }
    throw new Error(`still larger than ${config.maxBytes} bytes at the lowest quality`);
  } finally {
    await fs.rm(tmpVideo, { force: true });
    await fs.rm(tmpWebp, { force: true });
  }
}

async function exists(file) {
  return fs.access(file).then(() => true, () => false);
}

function needsLookup(entry, file) {
  if (!entry || entry.status === 'failed') return Promise.resolve(true);
  if (entry.status === 'none') {
    const age = Date.now() - Date.parse(entry.checkedAt || 0);
    return Promise.resolve(age > config.recheckDays * 24 * 60 * 60 * 1000);
  }
  return exists(file).then((found) => !found);
}

async function waitForApi() {
  for (let attempt = 1; attempt <= 60; attempt++) {
    try {
      const response = await fetch(`${config.apiUrl}/api/v1/status`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return;
    } catch {}
    await sleep(2000);
  }
  throw new Error(`The artwork API at ${config.apiUrl} didn't start`);
}

// ------------------------------------------------------------------- main

async function main() {
  await fs.mkdir(coversDir, { recursive: true });
  await fs.mkdir(path.dirname(config.stateFile), { recursive: true });
  let state = {};
  try {
    state = JSON.parse(await fs.readFile(config.stateFile, 'utf8'));
  } catch {}

  const albums = new Map();
  const names = new Set();
  const add = (album) => {
    // Albums added by link have no names until they've been looked up once.
    const known = state[album.id];
    if (!album.artist && known?.artist) Object.assign(album, { artist: known.artist, album: known.album });

    const existing = albums.get(album.id);
    if (existing) {
      // The same album from another source (say, by link and on the chart):
      // keep the first, but learn its names.
      if (!existing.artist && album.artist) Object.assign(existing, { artist: album.artist, album: album.album });
    } else {
      // Skip albums already in the list under another ID (say, a charting
      // album someone also looked up on the public site).
      if (album.artist && album.album && names.has(`${nameKey(album.artist)}|${nameKey(album.album)}`)) return;
      albums.set(album.id, album);
    }
    const named = albums.get(album.id);
    if (named.artist && named.album) names.add(`${nameKey(named.artist)}|${nameKey(named.album)}`);
  };
  for (const album of [...(await listedAlbums()), ...(await chartAlbums()), ...(await historyAlbums())]) add(album);

  // Keep albums from the public site for a while after they leave its history.
  const keepUntil = Date.now() - config.keepHistoryDays * 24 * 60 * 60 * 1000;
  for (const [id, entry] of Object.entries(state)) {
    if (entry.source === 'history' && Date.parse(entry.lastSeen || 0) > keepUntil) {
      add({ id, artist: entry.artist, album: entry.album, source: 'history', lastSeen: entry.lastSeen });
    }
  }
  console.log(`${albums.size} albums to cover`);
  if (!albums.size) throw new Error('No albums found: the charts and albums.txt were both empty');

  await waitForApi();

  const counts = { converted: 0, none: 0, failed: 0, kept: 0 };
  let lookups = 0;
  for (const album of albums.values()) {
    const file = path.join(coversDir, `${album.id}.webp`);
    if (!(await needsLookup(state[album.id], file))) {
      if (album.lastSeen) state[album.id].lastSeen = album.lastSeen;
      if (!state[album.id].artist && album.artist) Object.assign(state[album.id], { artist: album.artist, album: album.album });
      counts.kept++;
      continue;
    }
    if (lookups >= config.maxLookups) continue; // the rest wait for the next run
    lookups++;
    if (lookups > 1) await sleep(config.delayMs);

    const label = `${album.artist || '?'} - ${album.album || album.id}`;
    try {
      // Albums from the public site come with their video; look up the rest
      // by Apple Music link, or by name.
      let result = album.playlist ? { url: album.playlist } : null;
      if (!result && album.url) {
        result = await fetchJson(`${config.apiUrl}/api/v1/artwork/url?url=${encodeURIComponent(album.url)}`);
      } else if (!result) {
        const query = new URLSearchParams({ artist: album.artist, album: album.album });
        result = await fetchJson(`${config.apiUrl}/api/v1/artwork/search?${query}`);
      }
      const entry = {
        artist: album.artist || result?.artist,
        album: album.album || result?.album,
        source: album.source || 'chart',
        ...(album.lastSeen ? { lastSeen: album.lastSeen } : {}),
        checkedAt: new Date().toISOString(),
      };
      if (!result?.url) {
        state[album.id] = { ...entry, status: 'none' };
        counts.none++;
        continue;
      }
      const bytes = await convert(result.url, file);
      state[album.id] = { ...entry, status: 'animated' };
      counts.converted++;
      console.log(`Converted ${label} (${Math.round(bytes / 1024)} KB)`);
    } catch (error) {
      state[album.id] = {
        ...state[album.id],
        artist: album.artist || state[album.id]?.artist,
        album: album.album || state[album.id]?.album,
        source: album.source || 'chart',
        ...(album.lastSeen ? { lastSeen: album.lastSeen } : {}),
        status: 'failed',
        checkedAt: new Date().toISOString(),
      };
      counts.failed++;
      console.warn(`Failed ${label}: ${error.message}`);
    }
  }

  // Keep only albums in the current list.
  for (const id of Object.keys(state)) if (!albums.has(id)) delete state[id];
  for (const name of await fs.readdir(coversDir)) {
    if (!albums.has(path.basename(name, '.webp'))) await fs.rm(path.join(coversDir, name), { force: true });
  }

  const covers = {};
  for (const [id, entry] of Object.entries(state)) {
    if (entry.status === 'animated' && (await exists(path.join(coversDir, `${id}.webp`)))) {
      covers[id] = { artist: entry.artist, album: entry.album, url: `covers/${id}.webp` };
    }
  }
  await fs.writeFile(
    path.join(config.siteDir, 'index.json'),
    JSON.stringify({ version: 1, updated: new Date().toISOString(), covers }, null, 1)
  );
  await fs.writeFile(config.stateFile, JSON.stringify(state, null, 1));
  await fs.writeFile(
    path.join(config.siteDir, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>Animated album covers</title>
<p>Animated album covers for <a href="https://github.com/rustybusgaming/Apple-Music-Rich-Presence">Apple Music Rich Presence</a>.
${Object.keys(covers).length} covers, updated ${new Date().toUTCString()}. The list is in <a href="index.json">index.json</a>.</p>\n`
  );

  const waiting = [...albums.values()].length - counts.kept - lookups;
  console.log(
    `Done: ${Object.keys(covers).length} animated covers (${counts.converted} new), ${counts.none} without animation, ` +
      `${counts.failed} failed${waiting > 0 ? `, ${waiting} left for the next run` : ''}.`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
