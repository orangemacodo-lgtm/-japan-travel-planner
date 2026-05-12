// Mirror exactly what the UI's generate() builds, but with values plugged in for
// a 10-day Osaka/Kyoto trip. Run end-to-end and check every rule.
const https = require('https');

const days = 10;
const startDate = '2026-06-01';
const endDate = '2026-06-10';
const arrTime = '14:00';
const depTime = '18:00';
const regLabel = '大阪/京都';
const adults = '2';
const kids = '0';
const members = '夫妻';
const isCar = false;
const selectedInterests = ['美食', '神社', '老街'];
const beenBefore = false;
const requests = '偏好歷史建築與在地美食，住宿可大阪京都各半';
const isLong = days > 4;
const actPerDay = isLong ? '3-4（午餐+1景點+晚餐+1景點）' : '5-7活動含三餐';
const descLen = isLong ? '5字內' : '10字內';
const igLen = isLong ? '10字內有emoji' : '1-2句有emoji像網紅';

const prompt = `你是日本旅遊規劃師+IG網紅。繁體中文。

資訊：區域${regLabel}、${startDate}~${endDate}（${days}天）、抵達${arrTime}離開${depTime}、${adults}大${kids}小（${members}）、${isCar?'自駕':'大眾運輸'}、興趣：${selectedInterests.join('/')}${beenBefore?'、深度旅':''}
${requests?'需求：'+requests:''}

回傳純JSON：
{"tripTitle":"標題","overview":"摘要",
"advice":["建議1","建議2"],
"packingList":[{"category":"類","items":["物品"]}],
"itinerary":[{"dayNumber":1,"date":"${startDate}","region":"地區","theme":"主題",
"weather":{"condition":"天氣","temperature":"15~22°C","icon":"sunny"},
"activities":[{"time":"14:00","name":"景點名","description":"${descLen}描述",
"igCaption":"${igLen}","highlights":["亮點"],"type":"SIGHTSEEING",
"coordinates":{"lat":34.69,"lng":135.50},
"ticketInfo":{"required":false,"priceEstimate":"免費"},
"reservation":{"needed":false,"tips":""},
"travelToNext":{"mode":"${isCar?'car':'train'}","duration":"15分","distance":"3km"}}]}]}

規則：每天${actPerDay}、第一天從${arrTime}、最後天${depTime}前結束、type=FOOD/SIGHTSEEING/ACTIVITY/HOTEL、真實coordinates、餐廳具體店名+推薦菜、FOOD的reservation.needed=true+tips寫訂位方式、description精簡、JSON完整不截斷

去重規則（重要，只針對 type=SIGHTSEEING / FOOD / ACTIVITY / SHOPPING）：整趟 ${days} 天行程中，這些類型的 activity.name **不得重複出現**。同一家拉麵店、同一個神社、同一個市場都不可在不同天出現第二次。連鎖店若真的不同分店，必須在 name 標明分店（例：「一蘭拉麵 道頓堀店」vs「一蘭拉麵 京都八幡店」）。
⚠️ 例外：type=HOTEL 允許連續多天重複出現（旅客住同一家飯店是常態，不算違反去重）。

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
      if (resp.details) console.error(JSON.stringify(resp.details, null, 2).substring(0, 1500));
      process.exit(1);
    }
    const plan = JSON.parse(resp.text);
    console.log(`\n=== ${days}-day plan generated in ${elapsed}s ===`);
    console.log(`provider=${resp.provider} model=${resp.model} chunked=${resp.chunked} chunks=${resp.chunkCount}`);
    console.log(`tripTitle: ${plan.tripTitle}`);

    const counts = new Map();
    const byDay = [];
    const hotelByDay = [];
    for (const day of plan.itinerary || []) {
      const acts = day.activities || [];
      const allNames = acts.map(a => `${a.name}[${a.type || '?'}]`);
      const dedupNames = acts.filter(a => a?.type !== 'HOTEL').map(a => a.name);
      const hotels = acts.filter(a => a?.type === 'HOTEL').map(a => a.name);
      byDay.push({ d: day.dayNumber, theme: day.theme, allNames, hotels });
      hotelByDay.push({ d: day.dayNumber, hotels });
      for (const n of dedupNames) counts.set(n, (counts.get(n) || 0) + 1);
    }

    console.log('\n=== Itinerary ===');
    for (const d of byDay) console.log(`Day ${d.d} (${d.theme || '?'}): ${d.allNames.join(' | ')}`);

    console.log('\n=== Day count ===');
    console.log(byDay.length === days ? `✅ ${byDay.length}/${days} days` : `❌ ${byDay.length}/${days} days`);

    const dups = [...counts.entries()].filter(([, c]) => c > 1);
    console.log('\n=== Non-HOTEL duplicate report ===');
    if (dups.length === 0) console.log(`✅ No duplicates among 景點/餐廳/活動/購物 (${counts.size} unique).`);
    else { console.log(`❌ ${dups.length} duplicated non-HOTEL names:`); for (const [n, c] of dups) console.log(`  - "${n}" × ${c}`); }

    console.log('\n=== Hotel pattern ===');
    const hotelSummary = new Map();
    for (const { d, hotels } of hotelByDay) for (const h of hotels) {
      if (!hotelSummary.has(h)) hotelSummary.set(h, []);
      hotelSummary.get(h).push(d);
    }
    if (hotelSummary.size === 0) console.log('⚠️ No HOTEL entries in itinerary.');
    else for (const [name, list] of hotelSummary) console.log(`  ${name}: 住 day ${list.join(', ')}`);

    const PLACES = ['京都店', '梅田店', '大阪店', '心齋橋店', '難波店', '神戶店', '奈良店', '本店'];
    const CATEGORIES = ['拉麵', '燒肉', '燒鳥屋', '燒鳥', '京料理', '壽司', '居酒屋', '餐廳', '食堂', '咖啡廳', '咖啡', '燒餅', '蛋糕'];
    const REGION_PREFIXES = ['', '關西', '京都', '大阪', '嵐山', '梅田', '神戶', '奈良'];
    const allNames = byDay.flatMap(d => d.allNames.map(n => n.replace(/\[.*?\]$/, '')));
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
req.setTimeout(300000, () => { console.error('Timeout 300s'); req.destroy(); process.exit(1); });
req.write(body);
req.end();
