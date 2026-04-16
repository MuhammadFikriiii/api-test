const scraper = require('./scraper');

async function debug() {
    try {
        console.log("--- DEBUGGING LIST PAGE (PAGE 2) ---");
        const resList = await scraper._sourceGet('/page/2/');
        const cheerio = require('cheerio');
        const $list = cheerio.load(resList.data);
        
        console.log("Found articles:");
        $list('.listupd article.bs').each((i, el) => {
            const isSticky = $list(el).hasClass('sticky') || $list(el).find('.sticky').length > 0;
            const title = $list(el).find('.tt h2').text().trim();
            console.log(`${i+1}. [${isSticky ? 'STICKY' : 'NORMAL'}] ${title}`);
        });

        console.log("\n--- DEBUGGING DETAIL PAGE ---");
        const resDetail = await scraper._sourceGet('/anime/tales-of-herding-gods-subtitle-indonesia/');
        const $detail = cheerio.load(resDetail.data);
        
        console.log("Detail Title:", $detail('.entry-title').text().trim());
        console.log("Episode List Container (.eplister) length:", $detail('.eplister').length);
        console.log("Episode List Items (li) length:", $detail('.eplister li').length);
        
        if ($detail('.eplister li').length === 0) {
            console.log("Alternative: Checking .clst li");
            console.log(".clst li length:", $detail('.clst li').length);
        }

    } catch (e) {
        console.error("Debug Error:", e.message);
    }
}

debug();
