const https = require('https');
const days = 3;
const prompt = `你是日本旅遊規劃師。繁體中文。${days} 天大阪/京都行程，每天 3 活動。
JSON：{"tripTitle":"x","itinerary":[{"dayNumber":1,"date":"2026-06-01","activities":[
{"time":"10:00","name":"景點名","type":"SIGHTSEEING","coordinates":{"lat":0,"lng":0}}
]}]}
規則：coordinates 必須是該景點實際 lat/lng，金閣寺=35.0394,135.7292。不可填 0,0。`;
const body = JSON.stringify({ prompt });
const opts = { hostname: 'japan-travel-planner-orui.onrender.com', path: '/api/generate', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } };
const req = https.request(opts, (res) => {
  let data = ''; res.on('data', c => data += c);
  res.on('end', () => {
    const r = JSON.parse(data);
    if (!r.ok) { console.error('FAIL:', r.error); process.exit(1); }
    const plan = JSON.parse(r.text);
    console.log(`model=${r.model}`);
    for (const day of plan.itinerary || []) {
      for (const a of (day.activities || [])) {
        const c = a.coordinates || {};
        const bad = c.lat === 0 && c.lng === 0;
        console.log(`Day ${day.dayNumber} ${a.name}: lat=${c.lat} lng=${c.lng} ${bad ? '❌ BAD' : '✅'}`);
      }
    }
  });
});
req.on('error', e => { console.error(e.message); process.exit(1); });
req.setTimeout(120000, () => { req.destroy(); process.exit(1); });
req.write(body); req.end();
