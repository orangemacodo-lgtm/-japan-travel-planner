// Replicate the same conditions the UI uses to decide whether the 導航 button shows.
const https = require('https');
const days = 3;
const startDate = '2026-06-01';
const endDate = '2026-06-03';
const arrTime = '14:00';
const depTime = '18:00';
const regLabel = '大阪/京都';
const isCar = false;
const selectedInterests = ['美食', '神社', '老街'];
const isLong = days > 4;
const actPerDay = isLong ? '3-4（午餐+1景點+晚餐+1景點）' : '5-7活動含三餐';
const descLen = isLong ? '5字內' : '10字內';
const igLen = isLong ? '10字內有emoji' : '1-2句有emoji像網紅';

const prompt = `你是日本旅遊規劃師+IG網紅。繁體中文。

資訊：區域${regLabel}、${startDate}~${endDate}（${days}天）、抵達${arrTime}離開${depTime}、2大0小（夫妻）、${isCar?'自駕':'大眾運輸'}、興趣：${selectedInterests.join('/')}

回傳純JSON：
{"tripTitle":"標題","overview":"摘要",
"advice":["建議1"],
"packingList":[{"category":"類","items":["物品"]}],
"itinerary":[{"dayNumber":1,"date":"${startDate}","region":"地區","theme":"主題",
"weather":{"condition":"天氣","temperature":"15~22°C","icon":"sunny"},
"activities":[{"time":"14:00","name":"景點名","description":"${descLen}描述",
"igCaption":"${igLen}","highlights":["亮點"],"type":"SIGHTSEEING",
"coordinates":{"lat":0,"lng":0},
"ticketInfo":{"required":false,"priceEstimate":"免費"},
"reservation":{"needed":false,"tips":""},
"travelToNext":{"mode":"${isCar?'car':'train'}","duration":"15分","distance":"3km"}}]}]}

規則：每天${actPerDay}、type=FOOD/SIGHTSEEING/ACTIVITY/HOTEL、餐廳具體店名+推薦菜、description精簡

座標規則：coordinates 的 lat/lng **絕對不可以是 0/0 或範例值**。每個 activity 都要填它真實的緯度經度（金閣寺=35.0394,135.7292；道頓堀=34.6687,135.5018；清水寺=34.9949,135.7850）。`;

const body = JSON.stringify({ prompt });
const opts = { hostname: 'japan-travel-planner-orui.onrender.com', path: '/api/generate', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } };
const req = https.request(opts, (res) => {
  let data = ''; res.on('data', c => data += c);
  res.on('end', () => {
    const r = JSON.parse(data);
    if (!r.ok) { console.error('FAIL:', r.error); process.exit(1); }
    const plan = JSON.parse(r.text);
    console.log(`model=${r.model}\n`);
    let nav = 0, missingTravel = 0, missingCoord = 0, sameCoord = 0;
    for (const day of plan.itinerary || []) {
      const acts = day.activities || [];
      console.log(`Day ${day.dayNumber}:`);
      for (let i = 0; i < acts.length; i++) {
        const a = acts[i];
        const next = acts[i + 1];
        const c = a.coordinates || {};
        const tn = a.travelToNext;
        let status = '';
        if (i === acts.length - 1) status = '(last)';
        else {
          const hasTravel = !!tn?.duration;
          const hasCoord = !!a.coordinates && !!next?.coordinates;
          const same = hasCoord && c.lat === next.coordinates.lat && c.lng === next.coordinates.lng;
          if (!hasTravel) { status = '❌ no travelToNext'; missingTravel++; }
          else if (!hasCoord) { status = '❌ missing coord (cur or next)'; missingCoord++; }
          else if (same) { status = '⚠️ same coord as next'; sameCoord++; }
          else { status = `✅ NAV: dir/${c.lat},${c.lng}/${next.coordinates.lat},${next.coordinates.lng}`; nav++; }
        }
        console.log(`  [${i}] ${a.name}: coord=${c.lat},${c.lng} travelToNext=${tn ? `${tn.mode}/${tn.duration}/${tn.distance}` : 'MISSING'} ${status}`);
      }
    }
    console.log(`\nSummary: ${nav} nav OK, ${missingTravel} no travel, ${missingCoord} missing coord, ${sameCoord} same coord`);
  });
});
req.on('error', e => { console.error(e.message); process.exit(1); });
req.setTimeout(120000, () => { req.destroy(); process.exit(1); });
req.write(body); req.end();
