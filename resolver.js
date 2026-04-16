const axios = require('axios');
const cheerio = require('cheerio');

/**
 * ANICHIN RESOLVER MODULE
 * Menangani ekstraksi direct link dari anichin.stream dan ok.ru
 */
const resolver = {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    },

    /**
     * Resolve anichin.stream (JWPlayer based)
     */
    resolveAnichin: async (url) => {
        try {
            console.log(`[RESOLVER] Resolving Anichin Stream: ${url}`);
            
            const urlObj = new URL(url.trim());
            let id = urlObj.searchParams.get('id');
            
            if (!id) return null;
            id = id.trim(); // Bersihkan whitespace/newline

            const directUrl = `https://anichin.stream/hls/${id}.m3u8`;
            
            // Resolve deep URL for the user (e.g. 1a-1791.com)
            try {
                const res = await axios.get(directUrl, { headers: { 'Referer': 'https://anichin.stream/' }, timeout: 3000 });
                const lines = res.data.split('\n');
                const firstLevel = lines.find(l => l.trim() && !l.startsWith('#'));
                if (firstLevel) {
                    const finalUrl = firstLevel.startsWith('http') ? firstLevel : new URL(firstLevel, directUrl).href;
                    console.log(`\x1b[35m[RESOLVER] A1. Resolved ANICHIN -> ${finalUrl}\x1b[0m`);
                    return finalUrl; // Return the deep manifest URL
                }
            } catch (e) {
                console.warn('[RESOLVER] Manifest deep fetch failed, using parent m3u8');
            }
            
            return directUrl;
        } catch (e) {
            console.error('[RESOLVER ERROR] Anichin:', e.message);
            return null;
        }
    },

    /**
     * Resolve Okru (ok.ru) with HLS preference
     */
    resolveOkru: async (url) => {
        try {
            // Bersihkan URL dan ambil ID angka saja
            const idMatch = url.match(/\/(\d+)(?:\?|$)/);
            const videoId = idMatch ? idMatch[1] : url.split('/').pop().split('?')[0];
            
            console.log(`[RESOLVER] Resolving Okru: ${videoId}`);

            const apiUrl = `https://ok.ru/dk?cmd=videoPlayerMetadata&mid=${videoId}`;
            const pcHeaders = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Referer': 'https://ok.ru/',
                'X-Requested-With': 'XMLHttpRequest'
            };

            let metadataResult = null;

            // 1. Coba Direct Fetch (Metode VPS - Paling Ampuh)
            try {
                const directRes = await axios.get(apiUrl, { headers: pcHeaders, timeout: 5000 });
                metadataResult = directRes.data;
                console.log(`[RESOLVER] Direct Success: OK.RU`);
            } catch (e) {
                console.warn(`[RESOLVER] Direct Failed (${e.message}), trying proxies...`);
                // 2. Fallback Proxy jika direct diblokir
                const proxies = [
                    `https://corsproxy.io/?${encodeURIComponent(apiUrl)}`,
                    `https://api.allorigins.win/raw?url=${encodeURIComponent(apiUrl)}`
                ];

                for (const proxy of proxies) {
                    try {
                        const response = await axios.get(proxy, { timeout: 8000 });
                        const rawData = response.data;
                        metadataResult = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
                        
                        // Cek berbagai kemungkinan format OK.RU Metadata
                        if (metadataResult && (metadataResult.videos || metadataResult.hlsManifestUrl || (metadataResult.movie && metadataResult.movie.videos))) {
                            console.log(`[RESOLVER] Proxy Success: ${proxy.split('/')[2]}`);
                            break;
                        }
                    } catch (err) { continue; }
                }
            }

            if (metadataResult) {
                // Cari HLS di berbagai tempat (Metode Standar)
                let hlsUrl = metadataResult.hlsManifestUrl || metadataResult.hlsMasterPlaylistUrl || metadataResult.hlsPlaylistUrl;
                
                // Cek di dalam array videos/movie
                const videos = metadataResult.videos || (metadataResult.movie ? metadataResult.movie.videos : null);
                
                if (!hlsUrl && videos && Array.isArray(videos)) {
                    const hls = videos.find(v => v.name === 'hls' || (v.url && v.url.includes('.m3u8')));
                    if (hls && hls.url) hlsUrl = hls.url;
                }

                // BULLETPROOF: Deep Search via Stringify
                if (!hlsUrl) {
                    const metadataStr = JSON.stringify(metadataResult);
                    const m3u8Match = metadataStr.match(/"(https?:\/\/[^"]+\.m3u8[^"]*)"/i);
                    if (m3u8Match) hlsUrl = m3u8Match[1].replace(/\\/g, '');
                }

                if (hlsUrl) {
                    console.log(`\x1b[32m[RESOLVER] A1. Resolved OK.RU -> ${hlsUrl}\x1b[0m`);
                    return hlsUrl;
                }
            }

            // SENJATA PAMUNGKAS: Aggressive Scraping (Lebih kuat dari VPS)
            console.warn(`[RESOLVER] API Failed, performing Aggressive Scan for ID: ${videoId}...`);
            try {
                const embedUrl = `https://ok.ru/videoembed/${videoId}`;
                const htmlRes = await axios.get(embedUrl, { headers: pcHeaders, timeout: 8000 });
                const htmlBody = htmlRes.data;
                
                // 1. Cari via Regex di seluruh body (termasuk yang di-encode)
                const m3u8Regex = /https?[:%][^"&']+\.m3u8[^"&']*/gi;
                const matches = htmlBody.match(m3u8Regex);
                
                if (matches) {
                    for (let match of matches) {
                        // Bersihkan unicode ampersand dan escape slashes
                        let decoded = decodeURIComponent(match)
                            .replace(/\\u0026/g, '&')
                            .replace(/u0026/g, '&')
                            .replace(/\\/g, '');
                            
                        if (decoded.includes('.m3u8')) {
                            console.log(`\x1b[32m[RESOLVER] A1. Resolved OK.RU (Aggressive Scan) -> ${decoded}\x1b[0m`);
                            return decoded;
                        }
                    }
                }

                // 2. Fallback ke data-options (Metode VPS)
                const $ = cheerio.load(htmlBody);
                const optionsStr = $('div[data-options]').attr('data-options');
                if (optionsStr) {
                    const options = JSON.parse(optionsStr);
                    const metadataEmbed = typeof options.flashvars.metadata === 'string' ? JSON.parse(options.flashvars.metadata) : options.flashvars.metadata;
                    if (metadataEmbed && metadataEmbed.videos) {
                        const hls = metadataEmbed.videos.find(v => v.name === 'hls' || (v.url && v.url.includes('.m3u8')));
                        if (hls && hls.url) {
                            console.log(`\x1b[32m[RESOLVER] A1. Resolved OK.RU (Scraped) -> ${hls.url}\x1b[0m`);
                            return hls.url;
                        }
                    }
                }
            } catch (scrapeErr) {
                console.error(`[RESOLVER] Aggressive Scan Failed: ${scrapeErr.message}`);
            }

            console.error(`[RESOLVER] ❌ Gagal total extract m3u8 dari OK.RU ID: ${videoId}`);
            // Jika benar-benar mentok, log kunci datanya saja buat analisa
            if (metadataResult) console.log("Keys available:", Object.keys(metadataResult));
            
            return null; 
        } catch (e) {
            console.error('[RESOLVER ERROR] Okru:', e.message);
            return null;
        }
    },

    /**
     * Entry point to resolve any supported iframe URL
     */
    resolve: async (url) => {
        if (url.includes('anichin.stream')) {
            return await resolver.resolveAnichin(url);
        }
        if (url.includes('ok.ru')) {
            return await resolver.resolveOkru(url);
        }
        return url;
    }
};

module.exports = resolver;
