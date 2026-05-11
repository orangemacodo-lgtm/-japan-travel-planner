const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY || '';
const GROQ_KEY = process.env.GROQ_API_KEY || '';

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
  if (!API_KEY) return { ok: false, errors: [{ model: 'gemini', msg: 'GEMINI_API_KEY 未設定' }] };

  const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite'];
  const errors = [];

  for (const model of models) {
    try {
      console.log(`[Gemini] 嘗試 ${model}...`);
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
        .filter(p => p.text)
        .map(p => p.text)
        .join('');

      const finishReason = data.candidates?.[0]?.finishReason || 'unknown';

      if (!text) {
        const msg = `回應為空 (finishReason: ${finishReason})`;
        console.error(`[Gemini] ${model}: ${msg}`);
        errors.push({ model, msg });
        continue;
      }

      console.log(`[Gemini] ${model} 成功，${text.length} 字 (finishReason: ${finishReason})`);
      return { ok: true, provider: 'gemini', model, text, finishReason };
    } catch (e) {
      const msg = e.response?.data?.error?.message || e.message;
      console.error(`[Gemini] ${model} 失敗: ${msg}`);
      errors.push({ model, msg });
    }
  }
  return { ok: false, errors };
}

// ── Groq API 呼叫（fallback）────────────────────────────────
async function callGroq(prompt, maxTokens) {
  if (!GROQ_KEY) return { ok: false, errors: [{ model: 'groq', msg: 'GROQ_API_KEY 未設定' }] };

  const models = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
  const errors = [];

  // 強化 system prompt：完整性 + 精準度 + 精簡度三軸鎖
  const SYSTEM_PROMPT = `你是專業的日本旅遊規劃師，必須提供「精準到名字 + 具體推薦理由」的高品質行程。

═══ 規則 A：完整性（違反視為任務失敗）═══
A1. 只輸出 JSON，不要 markdown、不要解釋文字
A2. 如果使用者請求 N 天行程，itinerary 陣列長度必須剛好等於 N，一天都不能少
A3. 寧可每天活動數量少一點（最少 2 個），也要把所有天數完整列出
A4. 禁止「以此類推」「...」「(略)」等省略手法
A5. 禁止在所有請求天數列完之前提前結束輸出

═══ 規則 B：精準度（這是品質底線，違反等同籠統廢話）═══
B1. name 必須是真實存在的具體名稱
    ✅「金閣寺」「一蘭拉麵 道頓堀店」「黑門市場」「東大寺南大門」
    ❌「某著名寺廟」「美食拉麵店」「當地市場」「歷史景點」

B2. description 必須包含「為什麼推薦這裡」的具體理由
    ✅「全京都唯一保留江戶時代町家建築的石板街道」
    ✅「鍍金舍利殿映於鏡湖池，三層樓各自代表寢殿造、武家造、禪宗樣式」
    ❌「很美的地方」「值得一去」「日本必訪景點」

B3. 若 type=FOOD（餐廳），description 或 highlights 必須指出**招牌菜或具體特色**
    ✅「招牌黑蜜豬骨湯拉麵 + 半熟蛋叉燒丼套餐」
    ✅「炭火燒鳥附鳥心、雞皮、肝串三種限定部位」
    ❌「日式拉麵」「美味餐廳」「人氣店家」

B4. 若 type=SIGHTSEEING/ACTIVITY，highlights 必須給 2-3 個獨特賣點
    ✅["金箔外牆", "鏡湖池倒影攝影角度", "宇治抹茶冰淇淋限定"]
    ❌["漂亮", "很美", "值得"]

B5. 嚴禁使用空洞形容詞：「很棒」「漂亮」「值得一去」「超讚」「必去」「美麗」「特別」「很有名」

═══ 規則 C：精簡度（確保 10+ 天能完整塞進回應）═══
C1. description 每個不超過 70 字（精準優先，但別寫廢話）
C2. highlights 每元素 10-25 字，2-3 個元素
C3. igCaption 不超過 80 字（要含至少 1 個具體賣點）
C4. theme 不超過 25 字
C5. advice 陣列最多 5 個，每個不超過 30 字

═══ 黃金原則 ═══
寧可內容精緻而完整，絕對不要籠統而豐富、也不要中途斷掉。
每個欄位都要讓讀者「光看文字就知道為什麼要去這裡」。`;

  for (const model of models) {
    try {
      console.log(`[Groq] 嘗試 ${model}...`);
      const { data } = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        max_tokens: Math.min(maxTokens || 4500, 4500),
        response_format: { type: 'json_object' },
      }, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${GROQ_KEY}`,
        },
        timeout: 120000,
      });

      const text = data.choices?.[0]?.message?.content || '';
      const finishReason = data.choices?.[0]?.finish_reason || 'unknown';

      if (!text) {
        const msg = `回應為空 (finish_reason: ${finishReason})`;
        console.error(`[Groq] ${model}: ${msg}`);
        errors.push({ model, msg });
        continue;
      }

      console.log(`[Groq] ${model} 成功，${text.length} 字 (finish_reason: ${finishReason})`);
      return { ok: true, provider: 'groq', model, text, finishReason };
    } catch (e) {
      const msg = e.response?.data?.error?.message || e.message;
      console.error(`[Groq] ${model} 失敗: ${msg}`);
      errors.push({ model, msg });
    }
  }
  return { ok: false, errors };
}

// ── 統一 LLM 入口：Gemini → Groq fallback ───────────────────
async function callLLM(prompt, maxTokens) {
  const allErrors = [];

  // 1) Gemini
  const gem = await callGemini(prompt, maxTokens);
  if (gem.ok) return gem;
  allErrors.push(...gem.errors.map(e => ({ provider: 'gemini', ...e })));

  // 2) Fallback to Groq
  console.log('[LLM] Gemini 全失敗，切換 Groq...');
  const groq = await callGroq(prompt, maxTokens);
  if (groq.ok) return groq;
  allErrors.push(...groq.errors.map(e => ({ provider: 'groq', ...e })));

  // 3) Both providers exhausted
  const err = new Error('所有模型都失敗了，請稍後再試');
  err.details = allErrors;
  throw err;
}

// ── 主 API ───────────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  if (!API_KEY && !GROQ_KEY) {
    return res.status(500).json({ ok: false, error: '未設定 GEMINI_API_KEY 或 GROQ_API_KEY' });
  }

  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ ok: false, error: '缺少 prompt' });

    const { provider, model, text, finishReason } = await callLLM(prompt);
    const parsed = extractJSON(text);

    if (parsed) {
      return res.json({ ok: true, text: JSON.stringify(parsed), provider, model });
    }

    console.error(`[API] JSON 解析失敗。provider: ${provider}, 模型: ${model}, 原因: ${finishReason}`);
    console.error(`[API] 前 500 字: ${text.substring(0, 500)}`);
    res.status(500).json({
      ok: false,
      error: `AI 回傳了非 JSON 內容（${provider}/${model}）。請重試一次。`,
      preview: text.substring(0, 300),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, details: e.details || null });
  }
});

// ── 測試 API 連線 ───────────────────────────────────────────
app.get('/api/test', async (req, res) => {
  if (!API_KEY && !GROQ_KEY) return res.json({ ok: false, error: '未設定 GEMINI_API_KEY 或 GROQ_API_KEY' });
  try {
    const { provider, model, text } = await callLLM(
      '回傳 JSON：{"status":"ok","message":"連線成功"}。只要 JSON。', 256
    );
    const parsed = extractJSON(text);
    res.json({ ok: true, provider, model, rawPreview: text.substring(0, 300), parsed, jsonOk: !!parsed });
  } catch (e) {
    res.json({ ok: false, error: e.message, details: e.details || null });
  }
});

// ── 除錯：測試實際行程生成 ───────────────────────────────────
app.get('/api/debug-generate', async (req, res) => {
  if (!API_KEY && !GROQ_KEY) return res.json({ ok: false, error: '未設定 API KEY' });
  try {
    const prompt = `你是日本旅遊規劃師，用繁體中文。
規劃大阪 2 天行程，每天 3 個活動。
回傳純 JSON（不要 markdown）：
{"tripTitle":"標題","overview":"摘要","advice":["建議1"],
"packingList":[{"category":"衣物","items":["外套"]}],
"itinerary":[{"dayNumber":1,"date":"2026-05-01","region":"大阪","theme":"主題",
"activities":[{"time":"10:00","name":"景點","description":"描述","type":"SIGHTSEEING",
"highlights":["亮點"],"coordinates":{"lat":34.69,"lng":135.50}}]}]}`;

    const { provider, model, text, finishReason } = await callLLM(prompt, 4096);
    const parsed = extractJSON(text);
    res.json({
      ok: !!parsed,
      provider,
      model,
      finishReason,
      rawLength: text.length,
      rawPreview: text.substring(0, 800),
      parsed: parsed ? { tripTitle: parsed.tripTitle, dayCount: parsed.itinerary?.length } : null,
      jsonOk: !!parsed,
    });
  } catch (e) {
    res.json({ ok: false, error: e.message, details: e.details || null });
  }
});

// ── 即時匯率（JPY→TWD）────────────────────────────────────
app.get('/api/rate', async (req, res) => {
  try {
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
  if (!API_KEY && !GROQ_KEY) return res.status(500).json({ ok: false, error: '未設定 API KEY' });
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
回傳純 JSON 物件，鍵為 "suggestions"（不要 markdown）：
{"suggestions":[{"name":"名稱","description":"一句描述","type":"${category}",
"igCaption":"用IG網紅口吻介紹（有emoji）",
"highlights":["亮點1","亮點2"],
"coordinates":{"lat":0,"lng":0},
"estimatedStay":"60分鐘"}]}`;

    const { text } = await callLLM(prompt, 4096);
    let parsed = extractJSON(text);
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
  console.log(`\n🗾 Japan Travel Planner (Gemini + Groq fallback)`);
  console.log(`📡 http://localhost:${PORT}`);
  console.log(`🔑 Gemini Key: ${API_KEY ? '已設定 ✅' : '❌ 未設定'}`);
  console.log(`🔑 Groq Key:   ${GROQ_KEY ? '已設定 ✅' : '❌ 未設定'}`);
  console.log(`📌 主力：gemini-2.5-flash → 2.0-flash → 2.5-flash-lite`);
  console.log(`📌 備援：llama-3.3-70b-versatile → llama-3.1-8b-instant`);
  console.log(`🔧 測試：/api/test | 除錯：/api/debug-generate\n`);
});
