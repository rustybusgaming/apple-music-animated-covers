// Builds the animated album cover site that Apple Music Rich Presence uses.
//
//   1. Collects albums: Apple's official "most played albums" charts, plus any
//      Apple Music album links in albums.txt.
//   2. Asks the Apple Music Animated Artworks API
//      (https://github.com/m8tec/apple-music-animated-artworks, run locally as
//      a Docker service by the workflow) for each album's animated cover.
//   3. Converts the cover video into a small, looping animated WebP with
//      ffmpeg, the same way https://github.com/m8tec/animated-artwork-downloader
//      does.
//   4. Writes site/index.json, which the app reads to find covers.
//
// Covers and results from earlier runs are restored from the Actions cache, so
// each album is only looked up and converted once. Covers for albums that are
// no longer in the list are dropped, which keeps the site small.

import { execFile } from 'node:child_process';
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

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

// ------------------------------------------------------------------ albums

async function chartAlbums() {
  const albums = [];
  for (const storefront of config.storefronts) {
    const url = config.chartsUrl.replace('{storefront}', storefront).replace('{size}', config.chartSize);
    try {
      const data = await fetchJson(url);
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
    const url = line.replace(/#.*/, '').trim();
    if (!url) continue;
    const id = albumId(url);
    if (id) albums.push({ id, url });
    else console.warn(`albums.txt: not an Apple Music album link: ${url}`);
  }
  return albums;
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
  for (const album of [...(await listedAlbums()), ...(await chartAlbums())]) {
    if (!albums.has(album.id)) albums.set(album.id, album);
  }
  console.log(`${albums.size} albums to cover`);
  if (!albums.size) throw new Error('No albums found: the charts and albums.txt were both empty');

  await waitForApi();

  const counts = { converted: 0, none: 0, failed: 0, kept: 0 };
  let lookups = 0;
  for (const album of albums.values()) {
    const file = path.join(coversDir, `${album.id}.webp`);
    if (!(await needsLookup(state[album.id], file))) {
      counts.kept++;
      continue;
    }
    if (lookups >= config.maxLookups) continue; // the rest wait for the next run
    lookups++;
    if (lookups > 1) await sleep(config.delayMs);

    const label = `${album.artist || '?'} - ${album.album || album.id}`;
    try {
      const result = await fetchJson(`${config.apiUrl}/api/v1/artwork/url?url=${encodeURIComponent(album.url)}`);
      const entry = {
        artist: album.artist || result?.artist,
        album: album.album || result?.album,
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
      state[album.id] = { ...state[album.id], status: 'failed', checkedAt: new Date().toISOString() };
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
