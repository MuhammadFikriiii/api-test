const axios = require('axios');
const cheerio = require('cheerio');

// List domain cadangan untuk auto-fallback source
const SOURCE_DOMAINS = [
    'https://anichin.cafe',
];

let ACTIVE_SOURCE_URL = SOURCE_DOMAINS[0];

const getHeaders = (url) => ({
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G981B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.162 Mobile Safari/537.36',
    'Referer': url || ACTIVE_SOURCE_URL,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
});

const scraper = {
    _sourceGet: async (path) => {
        const domain = SOURCE_DOMAINS[0];
        const targetUrl = path.startsWith('http') ? path : `${domain}${path}`;
        const isVercel = process.env.VERCEL || process.env.VERCEL_URL;

        const attemptFetch = async (url, useProxy = false) => {
            const finalUrl = useProxy 
                ? `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}` 
                : url;
            
            return axios.get(finalUrl, {
                headers: getHeaders(domain),
                timeout: 20000
            });
        };

        try {
            console.log(`[SCRAPER] Fetching: ${targetUrl} (Proxy: false)`);
            return await attemptFetch(targetUrl, false);
        } catch (e) {
            // If 403 and on Vercel, try proxy once
            if ((e.response?.status === 403 || e.message.includes('403')) && isVercel) {
                console.warn(`[SCRAPER] 403 detected on Vercel, retrying via Proxy...`);
                try {
                    return await attemptFetch(targetUrl, true);
                } catch (proxyErr) {
                    throw new Error(`Scraper failed: 403 on direct AND proxy failed (${proxyErr.message})`);
                }
            }
            throw e;
        }
    },

    getLatest: async (page = 1) => {
        const pageNum = parseInt(page);
        const path = `/seri/?page=${pageNum}&status=&type=&order=update`;
        const response = await scraper._sourceGet(path);
        const $ = cheerio.load(response.data);
        const list = [];
        const seen = new Set();
        $('.listupd article.bs').each((i, el) => {
            // Skip sticky items on page > 1
            if (pageNum > 1 && ($(el).hasClass('sticky') || $(el).find('.sticky').length > 0)) {
                return;
            }

            const title = $(el).find('.tt h2').text().trim() || $(el).find('.tt').text().trim();
            const link = $(el).find('a').attr('href');
            const poster = $(el).find('img').attr('data-src') || $(el).find('img').attr('src');
            const ep = $(el).find('.epx, .epxs, .ep').text().trim();
            const slug = link ? link.replace(ACTIVE_SOURCE_URL, '').replace(/\/$/, '').split('/').pop() : '';
            if (title && slug && !seen.has(slug)) {
                seen.add(slug);
                list.push({ title, slug, poster, ep });
            }
        });
        return list;
    },

    getEpisode: async (slug) => {
        try {
            const response = await scraper._sourceGet(`/${slug}/`);
            const $ = cheerio.load(response.data);
            const title = $('.entry-title').text().trim();
            const servers = [];
            $('.mirror option').each((i, el) => {
                const name = $(el).text().trim();
                const value = $(el).attr('value');
                if (value) {
                    let url = value;
                    if (value.startsWith('ey') || /^[a-zA-Z0-9+/]+={0,2}$/.test(value)) {
                        try { url = Buffer.from(value, 'base64').toString(); } catch (e) { }
                    }
                    if (url.includes('iframe')) {
                        const match = url.match(/src="([^"]+)"/);
                        if (match) url = match[1];
                    }
                    if (url.startsWith('//')) url = 'https:' + url;
                    if (url && (url.startsWith('http') || url.includes('iframe'))) {
                        servers.push({ name: name || `Server ${i + 1}`, url });
                    }
                }
            });

            // FALLBACK: Jika tidak ada di dropdown, cari di container player
            if (servers.length === 0) {
                const selectors = [
                    '.video-content iframe',
                    '#embed_holder iframe',
                    '.player-embed iframe',
                    '#video-container iframe',
                    '.entry-content iframe',
                    'iframe'
                ];
                for (const selector of selectors) {
                    const src = $(selector).first().attr('src');
                    if (src) {
                        servers.push({ name: 'Default', url: src.startsWith('//') ? 'https:' + src : src });
                        break;
                    }
                }
            }
            const navigation = {};
            // Aggressive navigation detection
            $('.navep a, .nextprev a, .np-nav a, .next-prev-ep a, .pagination a, .ep-nav a, .nav-links a').each((i, el) => {
                const text = $(el).text().toLowerCase().trim();
                const link = $(el).attr('href');
                const rel = $(el).attr('rel');
                const className = $(el).attr('class') || '';
                const parentClass = $(el).parent().attr('class') || '';

                // Tetap support link pendek (/) dan link lengkap (.cafe)
                const isMatch = link && (link.includes(ACTIVE_SOURCE_URL) || link.startsWith('/'));
                
                if (link && link !== '#' && isMatch) {
                    const epSlug = link.replace(/\/$/, '').split('/').pop();
                    
                    // Logic to detect Prev vs Next
                    const isPrev = text.includes('prev') ||
                        text.includes('sebelum') ||
                        text.includes('back') ||
                        (rel && rel.includes('prev')) ||
                        className.includes('prev') ||
                        parentClass.includes('prev') ||
                        $(el).find('[class*="left"]').length > 0 ||
                        $(el).find('svg[class*="left"]').length > 0;

                    const isNext = text.includes('next') ||
                        text.includes('selanjut') ||
                        text.includes('forward') ||
                        (rel && rel.includes('next')) ||
                        className.includes('next') ||
                        parentClass.includes('next') ||
                        $(el).find('[class*="right"]').length > 0 ||
                        $(el).find('svg[class*="right"]').length > 0;

                    if (isPrev) navigation.previous_episode = epSlug;
                    if (isNext) navigation.next_episode = epSlug;
                }
            });

            if (!navigation.previous_episode || !navigation.next_episode) {
                $('a').each((i, el) => {
                    const txt = $(el).text().toLowerCase().trim();
                    const href = $(el).attr('href');
                    if (!href || href === '#' || (!href.includes(ACTIVE_SOURCE_URL) && !href.startsWith('/'))) return;
                    
                    const epSlug = href.replace(/\/$/, '').split('/').pop();
                    if (!epSlug || epSlug === 'anime' || epSlug === '') return;

                    const isNext = txt.includes('next') || txt.includes('selanjut') || $(el).attr('rel') === 'next' || $(el).hasClass('next') || $(el).find('i[class*="right"]').length > 0;
                    const isPrev = txt.includes('prev') || txt.includes('sebelum') || $(el).attr('rel') === 'prev' || $(el).hasClass('prev') || $(el).find('i[class*="left"]').length > 0;

                    if (isNext && !navigation.next_episode) {
                        navigation.next_episode = epSlug;
                    }
                    if (isPrev && !navigation.previous_episode) {
                        navigation.previous_episode = epSlug;
                    }
                });
            }

            const episodes_list = [];
            $('.eplister li, .episodelist li').each((i, el) => {
                const epNumText = $(el).find('.epl-num').text().trim();
                const epTitleText = $(el).find('.epl-title').text().trim();
                const epLink = $(el).find('a').attr('href');

                if (epLink) {
                    const epSlug = epLink.replace(/\/$/, '').split('/').pop();

                    // Start with the title or num
                    let epLabel = epTitleText || epNumText;

                    // If it's just a small number (index), try to find the real one in slug
                    if (epSlug.includes('episode-')) {
                        const slugNum = epSlug.split('episode-')[1].split('-')[0];
                        if (slugNum) epLabel = `Episode ${slugNum}`;
                    }

                    episodes_list.push({
                        episode: epLabel || `Ep ${i + 1}`,
                        slug: epSlug
                    });
                }
            });

            return { title, servers, navigation, episodes_list };
        } catch (e) { throw e; }
    },

    getHome: async (page = 1) => {
        try {
            const latest = await scraper.getLatest(page);

            // Get Popular (typically in sidebar or specific section)
            const response = await scraper._sourceGet('/');
            const $ = cheerio.load(response.data);
            const popular = [];

            $('.wpe-content article').each((i, el) => {
                const title = $(el).find('h2').text().trim();
                const link = $(el).find('a').attr('href');
                const poster = $(el).find('img').attr('data-src') || $(el).find('img').attr('src');
                const slug = link ? link.replace(ACTIVE_SOURCE_URL, '').replace(/\/$/, '').split('/').pop() : '';
                if (title && slug) {
                    popular.push({ title, slug, poster });
                }
            });

            return scraper._applyFilter({
                status: 'success',
                latest: latest,
                popular: popular.slice(0, 10)
            });
        } catch (e) {
            return { status: 'error', message: e.message };
        }
    },

    getOngoing: async (page = 1) => {
        const pageNum = parseInt(page);
        // Try fallback format if standard fails
        const path = pageNum > 1 ? `/status/ongoing/page/${pageNum}/` : '/status/ongoing/';
        const list = await scraper._scrapeSourceList(path, pageNum);
        return scraper._applyFilter({ status: 'success', data: list });
    },

    getCompleted: async (page = 1) => {
        const pageNum = parseInt(page);
        const path = pageNum > 1 ? `/status/completed/page/${pageNum}/` : '/status/completed/';
        const list = await scraper._scrapeSourceList(path, pageNum);
        return scraper._applyFilter({ status: 'success', data: list });
    },

    getGenres: async () => {
        try {
            const response = await scraper._sourceGet('/genres/');
            const $ = cheerio.load(response.data);
            const genres = [];
            $('.genreList li a').each((i, el) => {
                const name = $(el).text().trim();
                const href = $(el).attr('href');
                const slug = href ? href.replace(/\/$/, '').split('/').pop() : '';
                if (name && slug) {
                    genres.push({ name, slug });
                }
            });
            return scraper._applyFilter({ status: 'success', data: genres });
        } catch (e) { return { status: 'error', message: e.message }; }
    },

    getByGenre: async (slug, page = 1) => {
        const path = page > 1 ? `/genres/${slug}/page/${page}/` : `/genres/${slug}/`;
        const list = await scraper._scrapeSourceList(path, page);
        return scraper._applyFilter({ status: 'success', data: list });
    },

    getDetail: async (slug) => {
        try {
            // Check if slug is an episode slug (contains '-episode-' or '-ep-')
            let targetSlug = slug;
            const isEpisodeSlug = slug.includes('-episode-') || slug.includes('-ep-') || slug.includes('-episode');

            let html;
            let seriesUrl = '';

            if (isEpisodeSlug) {
                try {
                    // Try to fetch the episode page first to find the main series link
                    const epRes = await scraper._sourceGet(`/${slug}/`);
                    const $ep = cheerio.load(epRes.data);

                    // Look for Breadcrumb (Index 1 is usually the series)
                    let seriesUrl = $ep('.breadcrumb span a').attr('href') ||
                        $ep('.breadcrumb a').eq(1).attr('href') ||
                        $ep('.ninfo a').attr('href');

                    if (seriesUrl) {
                        // Extract slug from URL like https://anichin.cafe/anime/title/
                        const parts = seriesUrl.replace(/\/$/, '').split('/');
                        targetSlug = parts.pop();
                    } else {
                        // Stripping fallback
                        targetSlug = slug.split('-episode-')[0].split('-ep-')[0].split('-episode')[0];
                    }
                } catch (e) {
                    console.error("[SCRAPER] Failed to resolve series link from episode:", e.message);
                    targetSlug = slug.split('-episode-')[0].split('-ep-')[0].split('-episode')[0];
                }
            }

            const response = await scraper._sourceGet(`/anime/${targetSlug}/`);
            const $ = cheerio.load(response.data);

            const title = $('.entry-title').text().trim();
            const poster = $('.thumb img').attr('src');

            // Smarter synopsis extraction
            let synopsis = '';
            const synopsisSelectors = ['.desc p', '.sinopsis p', '.entry-content p', '.entry-content'];
            for (const selector of synopsisSelectors) {
                const text = $(selector).first().text().trim();
                if (text && !text.toLowerCase().startsWith('download') && !text.toLowerCase().startsWith('nonton')) {
                    synopsis = text;
                    break;
                }
            }
            if (!synopsis) {
                // Fallback to the first p that doesn't look like SEO junk
                $('.entry-content p').each((i, el) => {
                    const t = $(el).text().trim();
                    if (t.length > 30 && !t.toLowerCase().includes('download')) {
                        synopsis = t;
                        return false;
                    }
                });
            }

            const info = {};
            $('.info-content span').each((i, el) => {
                const text = $(el).text().split(':');
                if (text.length > 1) {
                    info[text[0].trim().toLowerCase().replace(/\s+/g, '_')] = text[1].trim();
                }
            });

            const genres = [];
            $('.genxed a').each((i, el) => {
                genres.push($(el).text().trim());
            });

            const episodes_list = [];
            // Try multiple possible selectors for the episode list
            let epItems = $('.eplister li');
            if (epItems.length === 0) epItems = $('.clst li');
            if (epItems.length === 0) epItems = $('.metasulist li');
            if (epItems.length === 0) epItems = $('.episodelist li');
            if (epItems.length === 0) epItems = $('#episode_list li');

            epItems.each((i, el) => {
                const epTitle = $(el).find('.eapt').text().trim() || $(el).find('.metasulist .setep').text().trim() || $(el).find('a').text().trim();
                const epNum = $(el).find('.eanu').text().trim() || (epItems.length - i).toString();
                const epDate = $(el).find('.eadate').text().trim() || $(el).find('.date').text().trim();
                const epLink = $(el).find('a').attr('href');
                const epSlug = epLink ? epLink.replace(/\/$/, '').split('/').pop() : '';

                if (epSlug) {
                    episodes_list.push({ title: epTitle, episode: epNum, date: epDate, slug: epSlug });
                }
            });

            return scraper._applyFilter({
                status: 'success',
                data: {
                    title, poster, synopsis, info, genres, episodes_list
                }
            });
        } catch (e) { return { status: 'error', message: e.message }; }
    },

    search: async (keyword, page = 1) => {
        const path = page > 1 ? `/page/${page}/?s=${encodeURIComponent(keyword)}` : `/?s=${encodeURIComponent(keyword)}`;
        const list = await scraper._scrapeSourceList(path);
        return scraper._applyFilter({ status: 'success', data: list });
    },

    getSchedule: async () => {
        try {
            const response = await scraper._sourceGet('/schedule/');
            const $ = cheerio.load(response.data);
            const schedule = [];

            $('.schedule .box').each((i, el) => {
                const day = $(el).find('.day').text().trim();
                const items = [];
                $(el).find('.list article').each((j, itemEl) => {
                    const title = $(itemEl).find('h2').text().trim();
                    const link = $(itemEl).find('a').attr('href');
                    const slug = link ? link.replace(/\/$/, '').split('/').pop() : '';
                    if (title && slug) items.push({ title, slug });
                });
                if (day) schedule.push({ day, items });
            });

            return scraper._applyFilter({ status: 'success', data: schedule });
        } catch (e) { return { status: 'error', message: e.message }; }
    },

    // Helper common scraper for lists
    _scrapeSourceList: async (path, page = 1) => {
        try {
            const response = await scraper._sourceGet(path);
            const $ = cheerio.load(response.data);
            const list = [];
            const pageNum = parseInt(page);
            const seen = new Set();

            // Try to find the MAIN list container to avoid "Featured/Pinned" sections
            let $container = $('.listupd').last(); // Usually the last one is the main update list
            if ($container.length === 0) $container = $('.listupd');

            $container.find('article.bs').each((i, el) => {
                // If page > 1, skip items that are likely "Sticky" (often the first few items if they have different structure)
                // In Cocoen themes, sticky items often have the 'sticky' class or are in a specific sub-div
                if (pageNum > 1 && ($(el).hasClass('sticky') || $(el).find('.sticky').length > 0)) {
                    return;
                }

                const title = $(el).find('.tt h2').text().trim() || $(el).find('.tt').text().trim();
                const link = $(el).find('a').attr('href');
                const poster = $(el).find('img').attr('data-src') || $(el).find('img').attr('src');
                const ep = $(el).find('.epx, .epxs, .ep').text().trim();
                const slug = link ? link.replace(ACTIVE_SOURCE_URL, '').replace(/\/$/, '').split('/').pop() : '';

                if (title && slug && !seen.has(slug)) {
                    seen.add(slug);
                    list.push({ title, slug, poster, ep });
                }
            });

            // FALLBACK: If we got nothing from the specific container, try global search but still filter stickies
            if (list.length === 0) {
                $('article.bs').each((i, el) => {
                    if (pageNum > 1 && ($(el).hasClass('sticky') || $(el).find('.sticky').length > 0)) return;

                    const title = $(el).find('.tt h2').text().trim() || $(el).find('.tt').text().trim();
                    const link = $(el).find('a').attr('href');
                    const poster = $(el).find('img').attr('data-src') || $(el).find('img').attr('src');
                    const ep = $(el).find('.epx, .epxs, .ep').text().trim();
                    const slug = link ? link.replace(ACTIVE_SOURCE_URL, '').replace(/\/$/, '').split('/').pop() : '';

                    if (title && slug && !seen.has(slug)) {
                        seen.add(slug);
                        list.push({ title, slug, poster, ep });
                    }
                });
            }

            return list;
        } catch (e) { return []; }
    },

    // Filter Branding
    _applyFilter: (data) => {
        if (!data) return data;
        if (Array.isArray(data)) return data.map(item => scraper._applyFilter(item));
        if (typeof data === 'object' && data !== null) {
            const filtered = {};
            for (const key in data) {
                const value = data[key];
                if (typeof value === 'string') {
                    const isUrl = ['poster', 'url', 'href', 'slug'].includes(key) || value.startsWith('http');
                    if (isUrl) {
                        filtered[key] = value;
                    } else {
                        filtered[key] = value
                            .replace(/anichin\.(care|moe|cam|vip|top|id|cafe|best|team)/gi, 'DonghuaWatch.my.id') // Branding replace
                            .replace(/anichin/gi, 'DonghuaWatch');
                    }
                } else if (typeof value === 'object') {
                    filtered[key] = scraper._applyFilter(value);
                } else {
                    filtered[key] = value;
                }
            }
            return filtered;
        }
        return data;
    }
};

module.exports = scraper;
