const express = require('express');
const axios = require('axios');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY || '';
const GROQ_KEY = process.env.GROQ_API_KEY || '';

// Render proxies through its load balancer, so trust X-Forwarded-For for real client IPs.
app.set('trust proxy', 1);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

const generateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: '請求太頻繁，請等 10 分鐘再試。每 10 分鐘最多 5 次行程生成。' },
});

const suggestLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: '請求太頻繁，請稍後再試。' },
});

// ── 從回應中提取 JSON ───────────────────────────────────────
function extractJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text.trim()); } catch (_) {}
  const cb = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (cb) { try { return JSON.parse(cb[1].trim()); } catch (_) {} }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch (_) {}
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
        generationConfig: { temperature: 0.3, maxOutputTokens: maxTokens || 65536 },
      }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 120000,
      });

      const parts = data.candidates?.[0]?.content?.parts || [];
      const text = parts.filter(p => p.text).map(p => p.text).join('');
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
// 多模型輪替：每個模型獨立 100K TPD，撞牆會自動 fallback 到下一個。
// 順序按品質（指令遵守度）排。Model IDs 用 /api/debug-models 驗過 Groq 上實際存在。
const GROQ_MODELS = [
  'llama-3.3-70b-versatile',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'qwen/qwen3-32b',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'llama-3.1-8b-instant',
];

async function callGroq(prompt, maxTokens) {
  if (!GROQ_KEY) return { ok: false, errors: [{ model: 'groq', msg: 'GROQ_API_KEY 未設定' }] };

  const models = GROQ_MODELS;
  const errors = [];

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

  const gem = await callGemini(prompt, maxTokens);
  if (gem.ok) return gem;
  allErrors.push(...gem.errors.map(e => ({ provider: 'gemini', ...e })));

  console.log('[LLM] Gemini 全失敗，切換 Groq...');
  const groq = await callGroq(prompt, maxTokens);
  if (groq.ok) return groq;
  allErrors.push(...groq.errors.map(e => ({ provider: 'groq', ...e })));

  const err = new Error('所有模型都失敗了，請稍後再試');
  err.details = allErrors;
  throw err;
}

// ── Chunking 輔助：rate-limit 自動等待 + retry ─────────────
async function callLLMWithRetry(prompt, label = '') {
  const MAX_RETRIES = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callLLM(prompt);
    } catch (e) {
      lastErr = e;
      const allMsgs = JSON.stringify(e.details || e.message || '');
      const m = allMsgs.match(/try again in ([\d.]+)s/i);
      if (m && attempt < MAX_RETRIES) {
        const waitMs = Math.ceil(parseFloat(m[1]) * 1000) + 800;
        console.log(`[${label}] Rate limit hit, attempt ${attempt}/${MAX_RETRIES}, wait ${waitMs}ms`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// ── 主 API（含 chunking：N≥6 天自動拆分）────────────────────
app.post('/api/generate', generateLimiter, async (req, res) => {
  if (!API_KEY && !GROQ_KEY) {
    return res.status(500).json({ ok: false, error: '未設定 GEMINI_API_KEY 或 GROQ_API_KEY' });
  }

  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ ok: false, error: '缺少 prompt' });

    const dayMatch = prompt.match(/(\d+)\s*天/);
    const totalDays = dayMatch ? parseInt(dayMatch[1], 10) : 0;
    const CHUNK_THRESHOLD = 6;
    const CHUNK_SIZE = 5;

    if (totalDays >= CHUNK_THRESHOLD) {
      const chunks = [];
      for (let s = 1; s <= totalDays; s += CHUNK_SIZE) {
        chunks.push({ start: s, end: Math.min(s + CHUNK_SIZE - 1, totalDays) });
      }
      console.log(`[Chunk] ${totalDays} 天 → ${chunks.length} 塊（每塊最多 ${CHUNK_SIZE} 天）`);

      const itinerary = [];
      const usedNames = new Set();
      let firstMeta = null;
      let usedProvider = null;
      let usedModel = null;

      for (let i = 0; i < chunks.length; i++) {
        const { start, end } = chunks[i];
        const chunkDays = end - start + 1;
        const isFirst = i === 0;

        const exclusionBlock = usedNames.size > 0
          ? `\n- 【跨塊嚴禁重複】下列「景點/餐廳/活動/購物」（type 為 SIGHTSEEING/FOOD/ACTIVITY/SHOPPING）已經在前面幾天用過，**絕對不可再出現**（連同義改名也不行）：\n  ${[...usedNames].join('、')}\n  ⚠️ 此清單不含 HOTEL，因為飯店連住多晚是合理的。`
          : '';

        const chunkPrompt = `${prompt}

【CHUNKING MODE — 此次只生成第 ${start} 到第 ${end} 天】
- itinerary 陣列長度必須剛好 = ${chunkDays}
- 每個 itinerary 物件的 dayNumber 從 ${start} 開始遞增到 ${end}
- ${isFirst ? '其他欄位（tripTitle、overview、advice、packingList）正常輸出豐富內容' : '其他欄位（tripTitle、overview、advice、packingList）可填空字串或空陣列以節省 token'}
- 仍然遵守規則 A/B/C：每天必須完整、每個活動必須具體精準
- 【本塊內也嚴禁重複】此塊第 ${start}-${end} 天的 SIGHTSEEING/FOOD/ACTIVITY/SHOPPING 類 activity.name 必須兩兩不同。HOTEL 類例外可重複。${exclusionBlock}`;

        console.log(`[Chunk] ${i + 1}/${chunks.length}: days ${start}-${end}, exclude=${usedNames.size}`);

        let result;
        let parsed;
        const MAX_LEN_RETRY = 1;
        for (let attempt = 0; attempt <= MAX_LEN_RETRY; attempt++) {
          const lengthNag = attempt === 0
            ? ''
            : `\n\n【上一次嘗試只回了 ${parsed?.itinerary?.length ?? 0} 天，但本塊需要 ${chunkDays} 天】請務必這次的 itinerary 陣列剛好 ${chunkDays} 個元素，dayNumber 從 ${start} 到 ${end}，每天 3-4 個活動。不可只回一天就停。`;
          result = await callLLMWithRetry(chunkPrompt + lengthNag, `Chunk ${i + 1}${attempt > 0 ? ` retry${attempt}` : ''}`);
          parsed = extractJSON(result.text);
          if (!parsed) {
            throw new Error(`Chunk ${i + 1} (days ${start}-${end}) JSON 解析失敗`);
          }
          const got = Array.isArray(parsed.itinerary) ? parsed.itinerary.length : 0;
          if (got >= chunkDays) break;
          console.warn(`[Chunk] ${i + 1} attempt ${attempt + 1}: 要求 ${chunkDays} 天，回 ${got} 天${attempt < MAX_LEN_RETRY ? '，重試' : '，放棄'}`);
        }

        if (Array.isArray(parsed.itinerary)) {
          if (parsed.itinerary.length !== chunkDays) {
            console.warn(`[Chunk] ${i + 1} 最終天數仍異常：要求 ${chunkDays} 天，得 ${parsed.itinerary.length} 天`);
          }
          for (const day of parsed.itinerary) {
            if (Array.isArray(day.activities)) {
              for (const act of day.activities) {
                // 飯店允許重複出現（連住多晚常態），不納入跨塊排除清單
                if (act?.name && act?.type !== 'HOTEL') usedNames.add(act.name);
              }
            }
          }
          itinerary.push(...parsed.itinerary);
        } else {
          console.error(`[Chunk] ${i + 1} 沒有 itinerary 陣列`);
        }

        if (isFirst) {
          firstMeta = parsed;
          usedProvider = result.provider;
          usedModel = result.model;
        }
      }

      const merged = { ...firstMeta, itinerary };
      // 統計時排除 HOTEL（連住合理），只看景點/餐廳/活動的重複狀況
      const allNames = itinerary.flatMap(d => (d.activities || []).filter(a => a?.type !== 'HOTEL').map(a => a.name).filter(Boolean));
      const counts = new Map();
      for (const n of allNames) counts.set(n, (counts.get(n) || 0) + 1);
      const dups = [...counts.entries()].filter(([, c]) => c > 1);
      if (dups.length > 0) {
        console.warn(`[Chunk] 合併後仍有 ${dups.length} 個非 HOTEL 重複 name：${dups.map(([n, c]) => `${n}×${c}`).join('、')}`);
      }
      console.log(`[Chunk] 合併完成：${itinerary.length} 天, 非 HOTEL 唯一活動 ${counts.size}/${allNames.length}`);
      return res.json({
        ok: true,
        text: JSON.stringify(merged),
        provider: usedProvider,
        model: usedModel,
        chunked: true,
        totalDays: itinerary.length,
        chunkCount: chunks.length,
      });
    }

    // 單次呼叫（≤5 天）
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

// ── 除錯：列出 Groq 上實際可用的模型 ───────────────────────
app.get('/api/debug-models', async (req, res) => {
  if (!GROQ_KEY) return res.json({ ok: false, error: 'GROQ_API_KEY 未設定' });
  try {
    const { data } = await axios.get('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${GROQ_KEY}` },
      timeout: 10000,
    });
    const available = (data.data || []).map(m => m.id).sort();
    const status = GROQ_MODELS.map(id => ({ id, available: available.includes(id) }));
    res.json({ ok: true, status, allAvailable: available });
  } catch (e) {
    res.json({ ok: false, error: e.message, details: e.response?.data });
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
app.post('/api/suggest', suggestLimiter, async (req, res) => {
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
  console.log(`\n🗾 Japan Travel Planner (Gemini + Groq + Chunking)`);
  console.log(`📡 http://localhost:${PORT}`);
  console.log(`🔑 Gemini Key: ${API_KEY ? '已設定 ✅' : '❌ 未設定'}`);
  console.log(`🔑 Groq Key:   ${GROQ_KEY ? '已設定 ✅' : '❌ 未設定'}`);
  console.log(`📌 主力：gemini-2.5-flash → 2.0-flash → 2.5-flash-lite`);
  console.log(`📌 備援：llama-3.3-70b → llama-4-scout → qwen3-32b → gpt-oss-120b → gpt-oss-20b → llama-3.1-8b`);
  console.log(`🧩 Chunking：≥6 天自動拆成 5 天/塊，含 rate-limit 自動 retry`);
  console.log(`🔧 測試：/api/test | 除錯：/api/debug-generate\n`);
});
