// 5-day end-to-end test of dedup + fake-name rules in a single (non-chunked) call.
const https = require('https');
const days = 5;
const prompt = `你是日本旅遊規劃師+IG網紅。繁體中文。

資訊：區域大阪/京都、2026-06-01~2026-06-05（${days}天）、抵達14:00離開18:00、2大0小（夫妻）、大眾運輸、興趣：美食/神社/老街
需求：偏好歷史建築與在地美食，住宿可大阪京都各半

回傳純JSON：
{"tripTitle":"標題","overview":"摘要",
"advice":["建議1","建議2"],
"packingList":[{"category":"類","items":["物品"]}],
"itinerary":[{"dayNumber":1,"date":"2026-06-01","region":"地區","theme":"主題",
"weather":{"condition":"天氣","temperature":"15~22°C","icon":"sunny"},
"activities":[{"time":"14:00","name":"景點名","description":"10字內描述",
"igCaption":"1-2句有emoji像網紅","highlights":["亮點"],"type":"SIGHTSEEING",
"coordinates":{"lat":34.69,"lng":135.50},
"ticketInfo":{"required":false,"priceEstimate":"免費"},
"reservation":{"needed":false,"tips":""},
"travelToNext":{"mode":"train","duration":"15分","distance":"3km"}}]}]}

規則：每天5-7活動含三餐、第一天從14:00、最後天18:00前結束、type=FOOD/SIGHTSEEING/ACTIVITY/HOTEL、真實coordinates、餐廳具體店名+推薦菜、FOOD的reservation.needed=true+tips寫訂位方式、description精簡、JSON完整不截斷

去重規則（重要）：整趟 ${days} 天行程中，每個 activity.name（含景點、餐廳、活動）**不得重複出現**。每天主題與活動都要不一樣，不可同一家拉麵店出現兩次、同一個神社走兩次。連鎖店若真的不同分店，必須在 name 標明分店（例：「一蘭拉麵 道頓堀店」vs「一蘭拉麵 京都八幡店」）。

店名規則（極重要，違反等於任務失敗）：activity.name 必須是 Google Maps 真的查得到的具體店名或景點名。
✅ 合法：「一蘭拉麵 道頓堀店」「金閣寺」「黑門市場」「壽司大」「蟹道樂 道頓堀本店」「東大寺南大門」
❌ 違反（絕對禁止用「類別＋地名」當店名）：「燒鳥屋 梅田店」「京料理 京都店」「關西拉麵 梅田店」「嵐山拉麵 京都店」「燒肉 京都店」「大阪拉麵」「京都壽司」
如果想不到真實的店名，就改推景點（type=SIGHTSEEING）而不是亂編一個聽起來像連鎖的假名字。`;

const body = JSON.stringify({ prompt });
const opts = {
  hostname: 'japan-travel-planner-orui.onrender.com',
  path: '/api/generate',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
};

const t0 = Date.now();
const req = https.request(opts, (res) => {
  let data = '';
  res.on('data', (c) => (data += c));
  res.on('end', () => {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    let resp;
    try { resp = JSON.parse(data); } catch (e) {
      console.error('Outer JSON parse fail:', e.message);
      console.error(data.substring(0, 500));
      process.exit(1);
    }
    if (!resp.ok) {
      console.error(`API error after ${elapsed}s:`, resp.error);
      console.error(JSON.stringify(resp.details, null, 2).substring(0, 1500));
      process.exit(1);
    }
    const plan = JSON.parse(resp.text);
    console.log(`\n=== 5-day plan generated in ${elapsed}s ===`);
    console.log(`provider=${resp.provider} model=${resp.model} chunked=${resp.chunked || false}`);
    console.log(`tripTitle: ${plan.tripTitle}`);

    const counts = new Map();
    const byDay = [];
    for (const day of plan.itinerary || []) {
      const names = (day.activities || []).map((a) => a.name);
      // 統計排除 HOTEL（連住合理）
      const dedupNames = (day.activities || []).filter(a => a?.type !== 'HOTEL').map(a => a.name);
      byDay.push({ d: day.dayNumber, theme: day.theme, names });
      for (const n of dedupNames) counts.set(n, (counts.get(n) || 0) + 1);
    }

    console.log('\n=== Itinerary ===');
    for (const d of byDay) {
      console.log(`Day ${d.d} (${d.theme || '?'}): ${d.names.join(' | ')}`);
    }

    console.log('\n=== Day count ===');
    console.log(byDay.length === days ? `✅ ${byDay.length}/${days} days` : `❌ ${byDay.length}/${days} days`);

    const dups = [...counts.entries()].filter(([, c]) => c > 1);
    console.log('\n=== Duplicate report ===');
    if (dups.length === 0) console.log('✅ No duplicates. Total unique activities:', counts.size);
    else { console.log(`❌ ${dups.length} duplicated names:`); for (const [n, c] of dups) console.log(`  - "${n}" × ${c}`); }

    const PLACES = ['京都店', '梅田店', '大阪店', '心齋橋店', '難波店', '神戶店', '奈良店', '本店'];
    const CATEGORIES = ['拉麵', '燒肉', '燒鳥屋', '燒鳥', '京料理', '壽司', '居酒屋', '餐廳', '食堂', '咖啡廳', '咖啡', '燒餅', '蛋糕'];
    const REGION_PREFIXES = ['', '關西', '京都', '大阪', '嵐山', '梅田', '神戶', '奈良'];
    const allNames = byDay.flatMap(d => d.names);
    const fakes = [];
    for (const name of allNames) {
      const place = PLACES.find(p => name.endsWith(p));
      if (!place) continue;
      const head = name.slice(0, -place.length).trim();
      const isBareCategory = REGION_PREFIXES.some(r => CATEGORIES.some(c => head === r + c));
      if (isBareCategory) fakes.push(name);
    }
    console.log('\n=== Fake-name report ===');
    if (fakes.length === 0) console.log('✅ No 類別+地名 fake-shop pattern detected.');
    else { console.log(`❌ ${fakes.length} likely fake names:`); for (const n of fakes) console.log(`  - "${n}"`); }
  });
});

req.on('error', (e) => { console.error('Request error:', e.message); process.exit(1); });
req.setTimeout(180000, () => { console.error('Timeout'); req.destroy(); process.exit(1); });
req.write(body);
req.end();
