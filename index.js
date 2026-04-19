const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const axios = require('axios');
const scraper = require('./scraper');
const resolver = require('./resolver');
const { createClient } = require('@supabase/supabase-js');

// Supabase — optional (graceful if not configured)
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_KEY)
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
    : null;

if (!supabase) console.warn('[DB] Supabase not configured — persistent cache disabled.');
else console.log('[DB] Supabase connected.');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============================================================
// SMART IN-MEMORY CACHE (Stale-While-Revalidate)
// ============================================================
const apiCache = new Map();
const CACHE_TTL   = 30 * 60 * 1000;        // 30 min fresh
const STALE_TTL   = 2  * 60 * 60 * 1000;   // 2 hr stale

const getCachedData = async (key, fetcher, forceRefresh = false) => {
    const now = Date.now();
    const cached = apiCache.get(key);

    // 1. Fresh cache
    if (!forceRefresh && cached && cached.data && (now - cached.timestamp < CACHE_TTL)) {
        return cached.data;
    }

    // 2. Join in-flight request
    if (cached && cached.promise) {
        return cached.promise;
    }

    // 3. Stale-While-Revalidate
    if (!forceRefresh && cached && cached.data && (now - cached.timestamp < STALE_TTL)) {
        console.log(`[SWR] Serving stale for: ${key}`);
        fetcher().then(data => {
            const hasData = data && (
                (data.latest && data.latest.length > 0) ||
                (data.data  && data.data.length  > 0)  ||
                (Array.isArray(data) && data.length > 0) ||
                (data.title)
            );
            if (hasData) {
                console.log(`[SWR] Updated: ${key}`);
                apiCache.set(key, { data, timestamp: Date.now() });
            }
        }).catch(err => console.error(`[SWR ERROR] ${key}: ${err.message}`));
        return cached.data;
    }

    // 4. Blocking fetch
    console.log(`[CACHE MISS] Fetching: ${key}`);
    const promise = fetcher();
    apiCache.set(key, { ...cached, promise, timestamp: cached ? cached.timestamp : 0 });

    try {
        const data = await promise;
        apiCache.set(key, { data, timestamp: Date.now() });
        delete apiCache.get(key)?.promise;
        return data;
    } catch (error) {
        if (cached && cached.data) {
            console.log(`[CACHE] Recovered stale: ${key}`);
            apiCache.set(key, { data: cached.data, timestamp: cached.timestamp });
            return cached.data;
        }
        apiCache.delete(key);
        throw error;
    }
};

// ============================================================
// MEMORY MONITOR — 1 GB limit, auto-evict stale entries
// ============================================================
setInterval(() => {
    const used = process.memoryUsage();
    const rssMB = Math.round(used.rss / 1024 / 1024);
    const heapMB = Math.round(used.heapUsed / 1024 / 1024);

    if (rssMB > 900) { // 900 MB threshold (out of 1 GB)
        console.warn(`⚠️ HIGH MEMORY: RSS=${rssMB}MB, Heap=${heapMB}MB — evicting stale cache (${apiCache.size} entries)`);
        const now = Date.now();
        for (const [key, value] of apiCache.entries()) {
            if (now - value.timestamp > STALE_TTL) {
                apiCache.delete(key);
            }
        }
        console.log(`🧹 Cache after eviction: ${apiCache.size} entries`);
    } else {
        console.log(`📊 Memory: RSS=${rssMB}MB, Heap=${heapMB}MB, Cache=${apiCache.size} entries`);
    }
}, 5 * 60 * 1000); // Every 5 min

// ============================================================
// PLAYER PAGE  (Light Blue Theme, Autoplay, Fixed Quality)
// ============================================================
app.get('/player', (req, res) => {
    let videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).send('No video URL provided');

    // We let the browser handle m3u8 directly because Vercel serverless functions
    // cannot proxy video streams without crashing/timing out/consuming gigabytes of bandwidth.
    // The Direct URLs we resolve (like 1a-1791.com) have Access-Control-Allow-Origin: *

    // Embed page (ok.ru/videoembed or raw anichin embed) — render as simple iframe
    const isEmbedPage = videoUrl.includes('ok.ru/videoembed') ||
        (videoUrl.includes('anichin') && !videoUrl.includes('.m3u8') && !videoUrl.includes('proxy/v'));

    if (isEmbedPage) {
        return res.send(`<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>DonghuaWatch Player</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body { width: 100%; height: 100%; background: #000; overflow: hidden; }
        iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: none; }
    </style>
</head>
<body>
    <iframe src="${videoUrl}" allowfullscreen allow="autoplay; fullscreen; picture-in-picture"></iframe>
</body>
</html>`);
    }

    // HLS / m3u8 player
    res.send(`<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>DonghuaWatch Player</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdn.plyr.io/3.7.8/plyr.css">
    <style>
        :root {
            --plyr-color-main: #38bdf8;
            --plyr-video-control-color: #fff;
            --plyr-video-control-color-hover: #38bdf8;
            --plyr-range-fill-background: #38bdf8;
            --plyr-video-progress-buffered-background: rgba(56,189,248,0.3);
        }
        * { margin:0; padding:0; box-sizing:border-box; }
        html,body {
            width:100%; height:100%;
            background:#000;
            overflow:hidden;
            font-family:'Outfit', sans-serif;
        }
        .container {
            width:100%; height:100%;
            display:flex;
            align-items:center;
            justify-content:center;
        }
        video { width:100%; height:100%; object-fit:contain; }
        
        .plyr { width: 100%; height: 100%; }

        /* Override Plyr colors to light-blue */
        .plyr--full-ui.plyr--video { --plyr-color-main: #38bdf8 !important; }
        .plyr--full-ui.plyr--video .plyr__control--overlaid {
            background: #38bdf8 !important;
            color: #fff !important;
            border: 3px solid rgba(255,255,255,0.3);
        }
        .plyr__control--overlaid svg { width:38px; height:38px; fill:#fff !important; }
        .plyr__progress input[type=range]::-webkit-slider-thumb { background:#38bdf8 !important; }
        .plyr__volume input[type=range]::-webkit-slider-thumb { background:#38bdf8 !important; }
        .plyr__menu__container .plyr__control[aria-checked=true]::before { background:#38bdf8 !important; }

        /* Error State */
        #error-msg {
            display:none;
            position:fixed;
            inset:0;
            background:rgba(0,0,0,0.92);
            color:#fff;
            flex-direction:column;
            align-items:center;
            justify-content:center;
            gap:16px;
            font-size:1rem;
            text-align:center;
            padding:20px;
            z-index:9999;
        }
        #error-msg.show { display:flex; }
        #error-msg button {
            padding:8px 24px;
            border-radius:8px;
            background:#38bdf8;
            color:#fff;
            font-weight:700;
            border:none;
            cursor:pointer;
        }
    </style>
</head>
<body>
    <div class="container">
        <video id="player" playsinline autoplay></video>
    </div>
    <div id="error-msg">
        <span>⚠️ Gagal memuat video.</span>
        <button onclick="location.reload()">Coba Lagi</button>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
    <script src="https://cdn.plyr.io/3.7.8/plyr.polyfilled.js"></script>
    <script>
        document.addEventListener('DOMContentLoaded', () => {
            const video  = document.getElementById('player');
            const errDiv = document.getElementById('error-msg');
            const source = "${videoUrl}";

            const defaultOptions = {
                autoplay: true,
                controls: ['play-large','play','progress','current-time','mute','volume','settings','pip','fullscreen'],
                settings: ['quality','speed'],
                tooltips: { controls: true, seek: true }
            };

            if (Hls.isSupported()) {
                const hls = new Hls({
                    maxBufferLength: 30,
                    maxMaxBufferLength: 60,
                    xhrSetup: (xhr) => { xhr.withCredentials = false; }
                });
                hls.loadSource(source);
                hls.attachMedia(video);
                window._hls = hls;

                hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
                    const levels = hls.levels;

                    // Build quality labels:
                    // Priority: HEIGHT (1080, 720, etc)
                    // Fallback: bandwidth in Kbps (e.g. "2500 kbps") when HEIGHT=0
                    const qualityOptions = levels.map((l, idx) => {
                        if (l.height && l.height > 0) return l.height;
                        // Bandwidth fallback — convert to nice label
                        if (l.bitrate) return Math.round(l.bitrate / 1000); // in Kbps
                        return idx + 1; // last resort: index
                    });

                    // Map Kbps values to friendly HD/SD labels for display
                    // Plyr uses the value as the quality "name" too
                    if (qualityOptions.length > 1) {
                        defaultOptions.quality = {
                            default: qualityOptions[0],
                            options: qualityOptions,
                            forced: true,
                            onChange: (newQ) => {
                                // Match by height first, then by kbps
                                hls.levels.forEach((level, idx) => {
                                    const qVal = (level.height && level.height > 0)
                                        ? level.height
                                        : Math.round(level.bitrate / 1000);
                                    if (qVal === newQ) hls.currentLevel = idx;
                                });
                            }
                        };
                    }

                    const player = new Plyr(video, defaultOptions);
                    window._player = player;

                    // Sync quality UI with actual HLS level change
                    hls.on(Hls.Events.LEVEL_SWITCHED, (e, d) => {
                        const h = hls.levels[d.level]?.height;
                        if (player && h) {
                            try { player.quality = h; } catch(_) {}
                        }
                    });

                    player.play().catch(() => {
                        // Autoplay blocked — wait for user interaction
                        video.addEventListener('click', () => player.play(), { once: true });
                    });
                });

                hls.on(Hls.Events.ERROR, (event, data) => {
                    if (data.fatal) {
                        switch (data.type) {
                            case Hls.ErrorTypes.NETWORK_ERROR:
                                console.warn('HLS network error, attempting recovery...');
                                hls.startLoad();
                                break;
                            case Hls.ErrorTypes.MEDIA_ERROR:
                                console.warn('HLS media error, recovering...');
                                hls.recoverMediaError();
                                break;
                            default:
                                console.error('Fatal HLS error:', data);
                                hls.destroy();
                                errDiv.classList.add('show');
                        }
                    }
                });
            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                // Native HLS (Safari)
                video.src = source;
                const player = new Plyr(video, defaultOptions);
                window._player = player;
                player.play().catch(() => {});
            } else {
                errDiv.querySelector('span').textContent = '⚠️ Browser tidak mendukung HLS.';
                errDiv.classList.add('show');
            }
        });
    </script>
</body>
</html>`);
});

// ============================================================
// IMAGE PROXY
// ============================================================
app.get('/api/proxy/image', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send('No URL provided');

    try {
        const targetUrl = new URL(url);
        const referer = `${targetUrl.protocol}//${targetUrl.hostname}/`;
        const response = await axios({
            method: 'get', url, responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Referer': referer,
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                'Cache-Control': 'no-cache'
            },
            timeout: 15000
        });
        res.set('Content-Type', response.headers['content-type'] || 'image/webp');
        res.set('Cache-Control', 'public, max-age=86400');
        response.data.pipe(res);
    } catch (error) {
        console.error('[IMAGE PROXY ERROR]:', error.message);
        res.status(500).send('Error');
    }
});

// ============================================================
// STREAMING PROXY (CORS Bypass + HLS Rewrite)
// ============================================================
app.get('/api/proxy/v', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('URL is required');

    let referer = 'https://anichin.stream/';
    if (targetUrl.includes('ok.ru')) referer = 'https://ok.ru/';
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

    try {
        const isManifest = targetUrl.includes('.m3u8');
        const response = await axios.get(targetUrl, {
            headers: { 'Referer': referer, 'User-Agent': userAgent },
            responseType: isManifest ? 'text' : 'stream',
            timeout: 15000
        });

        res.setHeader('Content-Type', response.headers['content-type']);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=3600');

        if (isManifest) {
            let manifest = response.data;
            const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
            const lines = manifest.split('\n').map(line => {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#')) {
                    let absoluteUrl = trimmed;
                    if (!trimmed.startsWith('http')) {
                        if (trimmed.startsWith('/')) {
                            const origin = new URL(targetUrl).origin;
                            absoluteUrl = origin + trimmed;
                        } else {
                            absoluteUrl = new URL(trimmed, baseUrl).href;
                        }
                    }
                    return `${req.protocol}://${req.get('host')}/api/proxy/v?url=${encodeURIComponent(absoluteUrl)}`;
                }
                return line;
            });
            res.send(lines.join('\n'));
        } else {
            response.data.pipe(res);
        }
    } catch (e) {
        console.error('[PROXY ERROR]', e.message);
        res.status(500).send(e.message);
    }
});

// ============================================================
// HOME / ONGOING / COMPLETED / SEARCH / GENRES / SCHEDULE
// All wrapped with smart cache
// ============================================================
app.get(['/api/home', '/api/home/:page'], async (req, res) => {
    const page = req.params.page || req.query.page || 1;
    try {
        const data = await getCachedData(`home-${page}`, () => scraper.getHome(page));
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
        res.json(data);
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

app.get(['/api/ongoing', '/api/ongoing/:page'], async (req, res) => {
    const page = req.params.page || req.query.page || 1;
    try {
        const data = await getCachedData(`ongoing-${page}`, () => scraper.getOngoing(page));
        res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=120');
        res.json(data);
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

app.get(['/api/completed', '/api/completed/:page'], async (req, res) => {
    const page = req.params.page || req.query.page || 1;
    try {
        const data = await getCachedData(`completed-${page}`, () => scraper.getCompleted(page));
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
        res.json(data);
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

app.get(['/api/search/:keyword', '/api/search/:keyword/:page'], async (req, res) => {
    try {
        const { keyword, page } = req.params;
        const data = await scraper.search(keyword, page || 1);
        res.json(data);
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

app.get('/api/detail/:slug', async (req, res) => {
    const { slug } = req.params;
    const forceRefresh = req.query.refresh === 'true';
    try {
        const data = await getCachedData(`detail-${slug}`, () => scraper.getDetail(slug), forceRefresh);
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
        res.json(data);
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

app.get('/api/genres', async (req, res) => {
    try {
        const data = await getCachedData('genres-list', () => scraper.getGenres());
        res.setHeader('Cache-Control', 's-maxage=86400');
        res.json(data);
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

app.get(['/api/genres/:slug', '/api/genres/:slug/:page'], async (req, res) => {
    const { slug, page } = req.params;
    try {
        const data = await getCachedData(`genre-${slug}-${page || 1}`, () => scraper.getByGenre(slug, page || 1));
        res.setHeader('Cache-Control', 's-maxage=3600');
        res.json(data);
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

app.get('/api/schedule', async (req, res) => {
    try {
        const data = await getCachedData('schedule', () => scraper.getSchedule());
        res.setHeader('Cache-Control', 's-maxage=3600');
        res.json(data);
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

app.get('/api/latest', async (req, res) => {
    const page = req.query.page || 1;
    try {
        const data = await getCachedData(`latest-${page}`, () => scraper.getLatest(page));
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
        res.json({ status: 'success', data });
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

// ============================================================
// EPISODE ENDPOINT
// — In-memory SWR cache
// — Supabase TTL: 3 days for anichin.stream, 3 hours for ok.ru
// ============================================================
app.get('/api/episode/:slug', async (req, res) => {
    const { slug } = req.params;

    try {
        // ─── STEP 1: Check Supabase persistent cache ───────────────
        if (supabase) {
            const { data: cached, error: dbErr } = await supabase
                .from('resolved_streams')
                .select('*')
                .eq('episode_slug', slug)
                .maybeSingle();

            if (cached && !dbErr) {
                const now = Date.now();
                const savedAt = new Date(cached.created_at || cached.updated_at || 0).getTime();
                const isOkru = cached.hls_url?.includes('ok.ru');
                // 3 days = 259200000 ms | 3 hours = 10800000 ms
                const TTL = isOkru ? 3 * 60 * 60 * 1000 : 3 * 24 * 60 * 60 * 1000;
                const expired = (now - savedAt) > TTL;

                if (!expired) {
                    console.log(`[CACHE HIT DB] ${slug} — provider: ${isOkru ? 'ok.ru' : 'anichin'} (${Math.round((now - savedAt)/3600000)}h old)`);
                    // Fetch episode scrape data for nav/title (faster via in-memory cache)
                    let episodeData = {};
                    try {
                        const scrapedData = await getCachedData(`episode-meta-${slug}`, () => scraper.getEpisode(slug));
                        episodeData = scrapedData?.data || scrapedData || {};
                    } catch (_) {}

                    return res.json({
                        status: 'success',
                        data: {
                            ...episodeData,
                            servers: [{ name: 'Server', url: cached.hls_url }]
                        }
                    });
                } else {
                    console.log(`[CACHE EXPIRED DB] ${slug} — TTL exceeded, purging...`);
                    // Delete expired entry in background
                    supabase.from('resolved_streams').delete().eq('episode_slug', slug).then(() => {});
                }
            }
        }

        // ─── STEP 2: Scrape + Resolve ────────────────────────────
        console.log(`[CACHE MISS] Scraping episode: ${slug}`);
        let data = await scraper.getEpisode(slug);
        const rawData = data?.data || data || {};

        let finalServers = [];

        // Resolve all server URLs in parallel
        const resolved = await Promise.all(
            (rawData.servers || []).map(async (server) => {
                const directUrl = await resolver.resolve(server.url);
                if (directUrl && directUrl !== server.url) {
                    return { name: server.name || 'Server', url: directUrl };
                }
                return null;
            })
        );

        const validServers = resolved.filter(Boolean);

        // Priority: anichin.stream first
        finalServers = validServers.filter(s => s.url.includes('anichin.stream'));

        // Fallback: ok.ru or any m3u8/mp4
        if (finalServers.length === 0) {
            const fallback = validServers.find(s =>
                s.url.includes('ok.ru') ||
                s.url.includes('.m3u8') ||
                s.url.includes('.mp4')
            );
            if (fallback) finalServers = [fallback];
        }

        // ─── STEP 3: Save to Supabase with provider-aware TTL ────
        if (finalServers.length > 0 && supabase) {
            const bestUrl = finalServers[0].url;
            const isOkru  = bestUrl.includes('ok.ru');
            const ttlNote  = isOkru ? '3h (ok.ru)' : '3d (anichin)';
            console.log(`[DB SAVE] Saving ${slug} — TTL: ${ttlNote}`);

            supabase.from('resolved_streams').upsert({
                episode_slug: slug,
                hls_url: bestUrl,
                series_name: rawData.title || slug,
                created_at: new Date().toISOString()
            }, { onConflict: 'episode_slug' }).then(({ error }) => {
                if (error) console.error('[DB ERROR]:', error.message);
                else console.log(`[DB SAVED] ${slug}`);
            });
        }

        res.json({
            status: 'success',
            data: {
                ...rawData,
                servers: finalServers
            }
        });
    } catch (e) {
        console.error('[EPISODE ERROR]', e.message);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// ============================================================
// ROOT — API Info
// ============================================================
app.get('/', (req, res) => {
    res.json({
        status: 'success',
        message: 'API-DonghuaBaru',
        version: '2.0.0',
        cache: {
            memory: `${apiCache.size} entries`,
            ram_limit: '1 GB (auto-evict at 900 MB)',
            supabase_ttl: 'anichin.stream: 3 days | ok.ru: 3 hours'
        },
        endpoints: {
            home: '/api/home/:page',
            latest: '/api/latest',
            search: '/api/search/:keyword',
            detail: '/api/detail/:slug',
            episode: '/api/episode/:slug',
            ongoing: '/api/ongoing/:page',
            completed: '/api/completed/:page',
            genres: '/api/genres',
            genre_detail: '/api/genres/:slug/:page',
            schedule: '/api/schedule',
            player: '/player?url=DIRECT_M3U8_URL',
            proxy_stream: '/api/proxy/v?url=TARGET_URL',
            proxy_image: '/api/proxy/image?url=IMAGE_URL'
        }
    });
});

app.listen(PORT, () => {
    console.log(`🚀 API-DonghuaBaru v2.0 running on http://localhost:${PORT}`);
    console.log(`📦 Cache TTL: 30m fresh | 2h stale | 1GB RAM limit`);
    console.log(`🔒 Supabase TTL: anichin=3d | ok.ru=3h`);
});
