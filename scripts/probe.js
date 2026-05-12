// Heavy probe — same prompt size as test_dedup.js — but request minimal output.
const https = require('https');
const days = 10;
const prompt = `你是日本旅遊規劃師+IG網紅。繁體中文。
資訊：區域大阪/京都、2026-06-01~2026-06-10（${days}天）、抵達14:00離開18:00、2大0小（夫妻）、大眾運輸、興趣：美食/神社/老街
需求：偏好歷史建築與在地美食，住宿可大阪京都各半
回傳 JSON 物件，只要：{"tripTitle":"x","itinerary":[{"dayNumber":1,"activities":[{"name":"a"}]}]}。其他欄位省略，1 個活動即可。`;
const body = JSON.stringify({ prompt });
const opts = {
  hostname: 'japan-travel-planner-orui.onrender.com', path: '/api/generate', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
};
const req = https.request(opts, (res) => {
  let data = '';
  res.on('data', (c) => (data += c));
  res.on('end', () => {
    try {
      const r = JSON.parse(data);
      if (r.ok) { console.log('READY'); process.exit(0); }
    } catch {}
    process.exit(1);
  });
});
req.on('error', () => process.exit(1));
req.setTimeout(40000, () => { req.destroy(); process.exit(1); });
req.write(body); req.end();
