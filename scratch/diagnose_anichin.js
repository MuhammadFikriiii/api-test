const axios = require('axios');
const cheerio = require('cheerio');

const TARGET_URL = 'https://anichin.cafe';

async function diagnose() {
    try {
        console.log("--- DIAGNOSING PAGE 2 ---");
        const resPage2 = await axios.get(`${TARGET_URL}/page/2/`, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const $page2 = cheerio.load(resPage2.data);
        
        console.log("First 10 articles on Page 2:");
        $page2('.listupd article.bs').slice(0, 10).each((i, el) => {
            const title = $page2(el).find('.tt h2').text().trim() || $page2(el).find('.tt').text().trim();
            const parentClass = $page2(el).parent().attr('class');
            const selfClass = $page2(el).attr('class');
            console.log(`${i+1}. [Self: ${selfClass}] [Parent: ${parentClass}] - ${title}`);
        });

        console.log("\n--- DIAGNOSING DETAIL PAGE ---");
        const detailSlug = 'tales-of-herding-gods-subtitle-indonesia';
        const resDetail = await axios.get(`${TARGET_URL}/anime/${detailSlug}/`, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const $detail = cheerio.load(resDetail.data);
        
        console.log("Looking for episode markers...");
        console.log("Number of scripts:", $detail('script').length);
        console.log("Has .eplister?", $detail('.eplister').length > 0);
        console.log("Has .clst?", $detail('.clst').length > 0);
        console.log("Has .last_epide?", $detail('.last_epide').length > 0);
        
        // Let's dump the HTML around where the episodes should be
        const contentHtml = $detail('.postbody').html();
        if (contentHtml) {
            console.log("\nHTML Snippet from .postbody (first 500 chars):");
            console.log(contentHtml.substring(0, 500));
        }

    } catch (e) {
        console.error("Diagnosis failed:", e.message);
    }
}

diagnose();
