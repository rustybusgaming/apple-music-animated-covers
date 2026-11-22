# Animated Album Covers

Animated (moving) album covers for [Apple Music Rich Presence](https://github.com/rustybusgaming/Apple-Music-Rich-Presence), so your Discord status can show them.

Once a day, a GitHub Action:

1. Collects albums from three places:
   - Apple's official charts of the most-played albums (US and UK, top 100 each).
   - The albums people recently looked up on [artwork.m8tec.top](https://artwork.m8tec.top), the public Apple Music Animated Artworks site. Those are kept for 30 days after they were last looked up there.
   - Any albums listed in [`albums.txt`](albums.txt).
2. Looks up each album's animated cover with the [Apple Music Animated Artworks API](https://github.com/m8tec/apple-music-animated-artworks), which runs inside the Action. Albums from the public site come with theirs already.
3. Converts the cover video into a small looping animated WebP with ffmpeg, the same way [Animated Artwork Downloader](https://github.com/m8tec/animated-artwork-downloader) does.
4. Publishes the covers and a list of them ([`index.json`](https://rustybusgaming.github.io/apple-music-animated-covers/index.json)) with GitHub Pages.

The app checks that list. If the album you're playing is in it, your status shows the animated cover; otherwise it shows the normal one.

Only albums from those three places are covered, and only some albums have an animated cover at all. Covers for albums that drop off the list are removed, which keeps the site small. Each album is only converted once.

## Adding albums

Add albums to [`albums.txt`](albums.txt), one per line, as an Apple Music album link or as `Artist - Album` (for example `Fleetwood Mac - Rumours`). The Action runs again when the file changes. To check whether an album has an animated cover at all, search for it on [artwork.m8tec.top](https://artwork.m8tec.top).

## Settings

The workflow reads these optional environment variables in `scripts/build.mjs`: `STOREFRONTS` (default `us,gb`), `CHART_SIZE` (default `100`), `COVER_SIZE` (pixels, default `320`), `COVER_FPS` (default `15`), `WEBP_QUALITY` (default `50`) and `MAX_COVER_BYTES` (default 4 MB).

## Credits and notice

Animated cover lookup by [m8tec/apple-music-animated-artworks](https://github.com/m8tec/apple-music-animated-artworks), and recent lookups from its public site, [artwork.m8tec.top](https://artwork.m8tec.top); conversion approach from [m8tec/animated-artwork-downloader](https://github.com/m8tec/animated-artwork-downloader).

The covers are the work of the artists and Apple Music. This project is unofficial and not affiliated with Apple. If you own a cover and want it removed, please open an issue.
