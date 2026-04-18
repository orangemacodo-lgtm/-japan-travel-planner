const express = require('express');
const axios   = require('axios');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY || '';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

// ── 從回應中提取 JSON ───────────────────────────────────────
function extractJSON(text) {
  if (!text) return null;

  // 1. 直接解析
  try { return JSON.parse(text.trim()); } catch (_) {}

  // 2. 去 markdown code block
  const cb = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (cb) { try { return JSON.parse(cb[1].trim()); } catch (_) {} }

  // 3. 找最大 {...}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch (_) {}
    // 4. 修復截斷的 JSON
    const s = m[0];
    const last = s.lastIndexOf(']');
    if (last > 0) {
      for (let i = 1; i <= 5; i++) {
        try { return JSON.parse(s.substring(0, last + 1) + '}'.repeat(i)); } catch (_) {}
      }
    }
  }
  return null;
}

// ── Gemini API 呼叫 ─────────────────────────────────────────
async function callGemini(prompt, maxTokens) {
  const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite'];

  for (const model of models) {
    try {
      console.log(`[AI] 嘗試 ${model}...`);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;

      const { data } = await axios.post(url, {
        contents: [{ parts: [{ text: prompt + '\n\n重要：只輸出 JSON，不要 markdown，不要解釋文字。' }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: maxTokens || 65536,
        },
      }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 120000,
      });

      const parts = data.candidates?.[0]?.content?.parts || [];
      const text = parts
        .filter(p => p.text)        // 只取文字 part（排除思考 part）
        .map(p => p.text)
        .join('');

      const finishReason = data.candidates?.[0]?.finishReason || 'unknown';

      if (!text) {
        console.error(`[AI] ${model}: 回應為空 (finishReason: ${finishReason})`);
        continue;
      }

      console.log(`[AI] ${model} 成功，${text.length} 字 (finishReason: ${finishReason})`);
      return { model, text, finishReason };
    } catch (e) {
      const msg = e.response?.data?.error?.message || e.message;
      console.error(`[AI] ${model} 失敗: ${msg}`);
    }
  }
  throw new Error('所有模型都失敗了，請稍後再試');
}

// ── 主 API ───────────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  if (!API_KEY) return res.status(500).json({ ok: false, error: '未設定 GEMINI_API_KEY' });

  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ ok: false, error: '缺少 prompt' });

    const { model, text, finishReason } = await callGemini(prompt);
    const parsed = extractJSON(text);

    if (parsed) {
      return res.json({ ok: true, text: JSON.stringify(parsed) });
    }

    // JSON 解析失敗 → 回傳錯誤 + 原始預覽（幫助除錯）
    console.error(`[API] JSON 解析失敗。模型: ${model}, 原因: ${finishReason}`);
    console.error(`[API] 前 500 字: ${text.substring(0, 500)}`);
    res.status(500).json({
      ok: false,
      error: `AI 回傳了非 JSON 內容（模型: ${model}）。請重試一次。`,
      preview: text.substring(0, 300),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── 測試 API 連線 ───────────────────────────────────────────
app.get('/api/test', async (req, res) => {
  if (!API_KEY) return res.json({ ok: false, error: '未設定 GEMINI_API_KEY' });
  try {
    const { model, text } = await callGemini(
      '回傳 JSON：{"status":"ok","message":"連線成功"}。只要 JSON。', 256
    );
    const parsed = extractJSON(text);
    res.json({ ok: true, model, rawPreview: text.substring(0, 300), parsed, jsonOk: !!parsed });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── 除錯：測試實際行程生成 ───────────────────────────────────
app.get('/api/debug-generate', async (req, res) => {
  if (!API_KEY) return res.json({ ok: false, error: '未設定 GEMINI_API_KEY' });
  try {
    const prompt = `你是日本旅遊規劃師，用繁體中文。
規劃大阪 2 天行程，每天 3 個活動。
回傳純 JSON（不要 markdown）：
{"tripTitle":"標題","overview":"摘要","advice":["建議1"],
"packingList":[{"category":"衣物","items":["外套"]}],
"itinerary":[{"dayNumber":1,"date":"2026-05-01","region":"大阪","theme":"主題",
"activities":[{"time":"10:00","name":"景點","description":"描述","type":"SIGHTSEEING",
"highlights":["亮點"],"coordinates":{"lat":34.69,"lng":135.50}}]}]}`;

    const { model, text, finishReason } = await callGemini(prompt, 4096);
    const parsed = extractJSON(text);
    res.json({
      ok: !!parsed,
      model,
      finishReason,
      rawLength: text.length,
      rawPreview: text.substring(0, 800),
      parsed: parsed ? { tripTitle: parsed.tripTitle, dayCount: parsed.itinerary?.length } : null,
      jsonOk: !!parsed,
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── 即時匯率（JPY→TWD）────────────────────────────────────
app.get('/api/rate', async (req, res) => {
  try {
    // 先嘗試主要來源
    const sources = [
      { url: 'https://open.er-api.com/v6/latest/JPY', parse: d => d.rates?.TWD },
      { url: 'https://api.exchangerate-api.com/v4/latest/JPY', parse: d => d.rates?.TWD },
    ];
    for (const src of sources) {
      try {
        const { data } = await axios.get(src.url, { timeout: 8000 });
        const rate = src.parse(data);
        if (rate && rate > 0) {
          console.log(`[rate] JPY→TWD = ${rate}`);
          return res.json({ ok: true, rate: +rate.toFixed(6), source: src.url });
        }
      } catch (_) {}
    }
    res.json({ ok: false, rate: 0.21, error: '無法取得即時匯率，使用預設值' });
  } catch (e) {
    res.json({ ok: false, rate: 0.21, error: e.message });
  }
});

// ── 附近景點推薦 ────────────────────────────────────────────
app.post('/api/suggest', async (req, res) => {
  if (!API_KEY) return res.status(500).json({ ok: false, error: '未設定 API KEY' });
  try {
    const { region, category, lat, lng, existingNames, date } = req.body;
    const catMap = {
      FOOD: '餐廳美食（給具體店名和推薦菜品）',
      SIGHTSEEING: '觀光景點',
      ACTIVITY: '體驗活動',
      SHOPPING: '購物商店',
    };
    const catDesc = catMap[category] || '各類景點';
    const nearDesc = lat && lng ? `座標 ${lat},${lng} 附近` : `${region || '日本'}地區`;
    const excludeStr = existingNames?.length ? `排除：${existingNames.join('、')}` : '';

    const prompt = `推薦 5 個${nearDesc}的${catDesc}。${excludeStr}
日期參考：${date || '近期'}。繁體中文。
回傳純 JSON 陣列（不要 markdown）：
[{"name":"名稱","description":"一句描述","type":"${category}",
"igCaption":"用IG網紅口吻介紹（有emoji）",
"highlights":["亮點1","亮點2"],
"coordinates":{"lat":0,"lng":0},
"estimatedStay":"60分鐘"}]`;

    const { text } = await callGemini(prompt, 4096);
    let parsed = extractJSON(text);
    // 可能是陣列或包在物件裡
    if (parsed && !Array.isArray(parsed)) {
      const arr = Object.values(parsed).find(v => Array.isArray(v));
      if (arr) parsed = arr;
    }
    if (Array.isArray(parsed) && parsed.length > 0) {
      return res.json({ ok: true, suggestions: parsed });
    }
    res.json({ ok: false, error: '無法解析推薦結果' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🗾  Japan Travel Planner (Gemini Free)`);
  console.log(`📡  http://localhost:${PORT}`);
  console.log(`🔑  Gemini Key: ${API_KEY ? '已設定 ✅' : '❌ 未設定'}`);
  console.log(`📌  模型：gemini-2.5-flash（自動降級）`);
  console.log(`🔧  測試：/api/test | 除錯：/api/debug-generate\n`);
});
