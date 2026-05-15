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
// ── In-memory 統計（Render 重啟後歸零，但用來看當下流量分布很夠）─
const stats = {
  startedAt: Date.now(),
  generate: { ok: 0, fail: 0 },
  suggest: { ok: 0, fail: 0 },
  modelHits: {},
  modelFails: {},
  lastFailures: [], // 最近 10 次失敗的 {ts, provider, model, msg}
  // [NEW] 每塊 chunk 的成功/失敗計數，用來看「最後一塊壞」這種型態
  chunkOutcomes: {}, // { "chunk_1": {ok, fail}, "chunk_2": {ok, fail}, ... }
  chunkIncomplete: [], // 最近 10 次「結構不完整」的紀錄
};
function recordModelFailure(provider, model, msg) {
  stats.lastFailures.unshift({ ts: new Date().toISOString(), provider, model, msg: String(msg).slice(0, 300) });
  if (stats.lastFailures.length > 10) stats.lastFailures.pop();
}
function recordChunkOutcome(chunkIndex, ok) {
  const key = `chunk_${chunkIndex + 1}`;
  if (!stats.chunkOutcomes[key]) stats.chunkOutcomes[key] = { ok: 0, fail: 0 };
  if (ok) stats.chunkOutcomes[key].ok++;
  else stats.chunkOutcomes[key].fail++;
}
function recordChunkIncomplete(chunkIndex, start, end, issues) {
  stats.chunkIncomplete.unshift({
    ts: new Date().toISOString(),
    chunk: chunkIndex + 1,
    days: `${start}-${end}`,
    issueCount: issues.length,
    sampleIssues: issues.slice(0, 5),
  });
  if (stats.chunkIncomplete.length > 10) stats.chunkIncomplete.pop();
}
// ── Quota-aware cooldown：429 後該 model 暫停 1 hr，避免每次都浪費 round-trip ──
const QUOTA_COOLDOWN_MS = 60 * 60 * 1000;
const quotaCooldown = {}; // { [modelName]: expiresAtTimestampMs }
function isQuotaCooldownActive(model) {
  const exp = quotaCooldown[model];
  return exp && exp > Date.now();
}
function markQuotaCooldown(model) {
  quotaCooldown[model] = Date.now() + QUOTA_COOLDOWN_MS;
  console.warn(`[Quota] ${model} cooldown 1h (until ${new Date(quotaCooldown[model]).toISOString()})`);
}
function cooldownSnapshot() {
  const out = {};
  for (const [m, exp] of Object.entries(quotaCooldown)) {
    const remainingMin = Math.ceil((exp - Date.now()) / 60000);
    if (remainingMin > 0) out[m] = remainingMin;
  }
  return out;
}
// ── 從回應中提取 JSON ───────────────────────────────────────
// [PATCH-E] 加入 wasTruncated 參數：若上游已知是截斷，禁用「強行補 }」的救活模式。
function extractJSON(text, wasTruncated = false) {
  if (!text) return null;
  try { return JSON.parse(text.trim()); } catch (_) {}
  const cb = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (cb) { try { return JSON.parse(cb[1].trim()); } catch (_) {} }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch (_) {}
    // 只在「上游沒回報截斷」時，才嘗試補尾巴救活——避免把破爛 JSON 偽裝成成功。
    if (!wasTruncated) {
      const s = m[0];
      const last = s.lastIndexOf(']');
      if (last > 0) {
        for (let i = 1; i <= 5; i++) {
          try { return JSON.parse(s.substring(0, last + 1) + '}'.repeat(i)); } catch (_) {}
        }
      }
    } else {
      console.warn('[extractJSON] 回應為截斷狀態，拒絕嘗試救活。');
    }
  }
  return null;
}
// ── FOOD name 真實性偵測（heuristic）───────────────────────
// 已知日本連鎖（漢字寫法常見，不一定含假名，故 whitelist）
const KNOWN_CHAINS = [
  '一蘭', '一風堂', '金龍', '蟹道樂', '蟹道楽', 'かに道楽', '自由軒', '壽司大', '寿司大', '次郎',
  'すき家', 'スシロー', 'くら寿司', 'はま寿司', '丸亀製麺', 'CoCo壱', 'いきなりステーキ',
  '吉野家', '松屋', 'モスバーガー', 'ロッテリア', 'てんや', '幸楽苑', '王将',
  'だるま', '自由軒', '銀のあん', '魚べい', '無添くら寿司', '大戸屋',
  'Pablo', 'Bills', 'Starbucks', 'スターバックス',
  '梅田', // bare 梅田 isn't a restaurant — caught by other rules but kept for known venue
  '黑門市場', '錦市場', '築地', // markets often confused for FOOD type
];
const HIRAGANA = /[぀-ゟ]/;
const KATAKANA = /[゠-ヿ]/;
const ROMAN = /[A-Za-z]/;
function isSuspectFoodName(name) {
  if (!name || typeof name !== 'string') return true;
  const n = name.trim();
  if (HIRAGANA.test(n) || KATAKANA.test(n)) return false;
  if (ROMAN.test(n)) return false;
  if (KNOWN_CHAINS.some(c => n.includes(c))) return false;
  return true;
}
function annotateSuspectFood(plan) {
  const suspects = [];
  for (const day of plan?.itinerary || []) {
    for (const act of day?.activities || []) {
      if (act?.type === 'FOOD' && isSuspectFoodName(act.name)) {
        act._suspect = true;
        suspects.push(`Day ${day.dayNumber}: ${act.name}`);
      }
    }
  }
  return suspects;
}
// ── 每日 SIGHTSEEING ≥ 3 硬規則檢查 ──
const MIN_SIGHTSEEING_PER_DAY = 3;
function findSightseeingShortfall(plan) {
  const shorts = [];
  for (const day of plan?.itinerary || []) {
    const cnt = (day.activities || []).filter(a => a?.type === 'SIGHTSEEING').length;
    if (cnt < MIN_SIGHTSEEING_PER_DAY) shorts.push({ dayNumber: day.dayNumber, count: cnt });
  }
  return shorts;
}
function buildSightseeingNag(shorts) {
  if (!shorts?.length) return '';
  const list = shorts.map(s => `Day ${s.dayNumber}(只有 ${s.count} 個)`).join('、');
  return `\n\n【上次違反硬規則】${list} 的 type=SIGHTSEEING 不到 ${MIN_SIGHTSEEING_PER_DAY} 個。請重新生成，每天 type=SIGHTSEEING 至少 ${MIN_SIGHTSEEING_PER_DAY} 個；若想不到就把 ACTIVITY/SHOPPING 改成 SIGHTSEEING 補齊。`;
}
// [PATCH-D] ── 結構完整性檢查：theme/region/coordinates 缺失偵測 ──
// 這是修正本次 bug 的核心。原本驗證只看「天數」和「景點數」，所以模型只要交骨架就能過關。
// 現在每個欄位都要齊全才放行。
const COORD_REQUIRED_TYPES = new Set(['SIGHTSEEING', 'FOOD', 'ACTIVITY', 'SHOPPING']);
function findIncompleteFields(parsed, expectedStart, expectedEnd) {
  const issues = [];
  if (!Array.isArray(parsed?.itinerary)) {
    issues.push('missing itinerary array');
    return issues;
  }
  const expectedDays = expectedEnd - expectedStart + 1;
  if (parsed.itinerary.length !== expectedDays) {
    issues.push(`day count: ${parsed.itinerary.length}/${expectedDays}`);
  }
  for (const day of parsed.itinerary) {
    const dn = day?.dayNumber ?? '?';
    if (!day?.theme || typeof day.theme !== 'string' || !day.theme.trim()) {
      issues.push(`Day ${dn}: missing/empty theme`);
    }
    if (!day?.region || typeof day.region !== 'string' || !day.region.trim()) {
      issues.push(`Day ${dn}: missing/empty region`);
    }
    const activities = Array.isArray(day?.activities) ? day.activities : [];
    if (activities.length < 4) {
      issues.push(`Day ${dn}: only ${activities.length} activities (need >=4)`);
    }
    for (let idx = 0; idx < activities.length; idx++) {
      const act = activities[idx];
      if (!act?.name || typeof act.name !== 'string' || !act.name.trim()) {
        issues.push(`Day ${dn} act#${idx + 1}: missing name`);
        continue;
      }
      if (COORD_REQUIRED_TYPES.has(act?.type)) {
        const lat = act?.coordinates?.lat;
        const lng = act?.coordinates?.lng;
        if (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng)) {
          issues.push(`Day ${dn} "${act.name}": missing/invalid coordinates`);
        }
      }
    }
  }
  return issues;
}
function buildIncompleteNag(issues) {
  if (!issues.length) return '';
  const preview = issues.slice(0, 8).map(i => `  - ${i}`).join('\n');
  return `\n\n【上次回應結構不完整，必須修正】\n${preview}\n請務必：\n1. 每天填齊非空的 theme、region 字串\n2. 每個 SIGHTSEEING/FOOD/ACTIVITY/SHOPPING 活動填入正確的 coordinates {lat: 數字, lng: 數字}\n3. 每個活動填齊 name（不可空字串）\n不可省略、不可寫 null、不可寫空字串。`;
}
// ── Gemini API 呼叫 ─────────────────────────────────────────
async function callGemini(prompt, maxTokens) {
  if (!API_KEY) return { ok: false, errors: [{ model: 'gemini', msg: 'GEMINI_API_KEY 未設定' }] };
  const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite'];
  const errors = [];
  for (const model of models) {
    if (isQuotaCooldownActive(model)) {
      const remainingMin = Math.ceil((quotaCooldown[model] - Date.now()) / 60000);
      console.log(`[Gemini] 跳過 ${model}（quota cooldown，剩 ${remainingMin} 分鐘）`);
      errors.push({ model, msg: `跳過：quota cooldown 中（剩 ${remainingMin} 分）` });
      continue;
    }
    try {
      console.log(`[Gemini] 嘗試 ${model}（maxTokens=${maxTokens || 65536}）...`);
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
        stats.modelFails[model] = (stats.modelFails[model] || 0) + 1;
        recordModelFailure('gemini', model, msg);
        continue;
      }
      if (finishReason === 'MAX_TOKENS') {
        const msg = `回應被截斷 (finishReason: MAX_TOKENS, 字數=${text.length})`;
        console.error(`[Gemini] ${model}: ${msg}`);
        errors.push({ model, msg });
        stats.modelFails[model] = (stats.modelFails[model] || 0) + 1;
        recordModelFailure('gemini', model, msg);
        continue;
      }
      console.log(`[Gemini] ${model} 成功，${text.length} 字 (finishReason: ${finishReason})`);
      stats.modelHits[model] = (stats.modelHits[model] || 0) + 1;
      return { ok: true, provider: 'gemini', model, text, finishReason, truncated: false, priorErrors: errors };
    } catch (e) {
      const msg = e.response?.data?.error?.message || e.message;
      const status = e.response?.status || null;
      const detailMsg = status ? `HTTP ${status} - ${msg}` : msg;
      console.error(`[Gemini] ${model} 失敗: ${detailMsg}`);
      errors.push({ model, msg: detailMsg });
      stats.modelFails[model] = (stats.modelFails[model] || 0) + 1;
      recordModelFailure('gemini', model, detailMsg);
      if (status === 429) markQuotaCooldown(model);
    }
  }
  return { ok: false, errors };
}
// ── Groq API 呼叫（fallback）────────────────────────────────
const GROQ_MODELS = [
  'llama-3.3-70b-versatile',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'qwen/qwen3-32b',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'llama-3.1-8b-instant',
];
// [PATCH-B] 每個 Groq 模型的實際輸出上限。原本一律封頂 8000，會把長 chunk 腰斬。
// 不同模型支援的 max_completion_tokens 不同，這裡用各家文件上的安全值。
const GROQ_OUTPUT_LIMITS = {
  'llama-3.3-70b-versatile': 32768,
  'meta-llama/llama-4-scout-17b-16e-instruct': 8192,
  'qwen/qwen3-32b': 32768,
  'openai/gpt-oss-120b': 32768,
  'openai/gpt-oss-20b': 32768,
  'llama-3.1-8b-instant': 8192,
};
async function callGroq(prompt, maxTokens) {
  if (!GROQ_KEY) return { ok: false, errors: [{ model: 'groq', msg: 'GROQ_API_KEY 未設定' }] };
  const models = GROQ_MODELS;
  const errors = [];
  const SYSTEM_PROMPT = '你是日本旅遊規劃師，輸出**只能**是純 JSON（不要 markdown、不要解釋文字）。完整輸出所有要求的天數，不可省略、不可中途截斷。每個活動必須填齊 name、type、coordinates(lat/lng 數字)。';
  // [PATCH-B] 不再硬封頂 8000；改成「要求值 vs 模型上限」取小。預設提升到 16000。
  const requested = maxTokens || 16000;
  for (const model of models) {
    const modelCap = GROQ_OUTPUT_LIMITS[model] || 8000;
    const effectiveMax = Math.min(requested, modelCap);
    try {
      console.log(`[Groq] 嘗試 ${model}（max_tokens=${effectiveMax}, cap=${modelCap}）...`);
      const { data } = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        max_tokens: effectiveMax,
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
        stats.modelFails[model] = (stats.modelFails[model] || 0) + 1;
        recordModelFailure('groq', model, msg);
        continue;
      }
      if (finishReason === 'length') {
        const msg = `回應被截斷 (finish_reason: length, 字數=${text.length}, max_tokens=${effectiveMax})`;
        console.error(`[Groq] ${model}: ${msg}`);
        errors.push({ model, msg });
        stats.modelFails[model] = (stats.modelFails[model] || 0) + 1;
        recordModelFailure('groq', model, msg);
        continue;
      }
      console.log(`[Groq] ${model} 成功，${text.length} 字 (finish_reason: ${finishReason})`);
      stats.modelHits[model] = (stats.modelHits[model] || 0) + 1;
      return { ok: true, provider: 'groq', model, text, finishReason, truncated: false };
    } catch (e) {
      const msg = e.response?.data?.error?.message || e.message;
      const status = e.response?.status || null;
      const detailMsg = status ? `HTTP ${status} - ${msg}` : msg;
      console.error(`[Groq] ${model} 失敗: ${detailMsg}`);
      errors.push({ model, msg: detailMsg });
      stats.modelFails[model] = (stats.modelFails[model] || 0) + 1;
      recordModelFailure('groq', model, detailMsg);
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
// [PATCH-A] callLLMWithRetry 現在會把 maxTokens 傳下去。原本直接丟掉，導致 Groq 永遠用預設 8000。
async function callLLMWithRetry(prompt, label = '', maxTokens) {
  const MAX_RETRIES = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callLLM(prompt, maxTokens);
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
// ── 主 API（含 chunking：N≥5 天自動拆分）────────────────────
app.post('/api/generate', generateLimiter, async (req, res) => {
  if (!API_KEY && !GROQ_KEY) {
    return res.status(500).json({ ok: false, error: '未設定 GEMINI_API_KEY 或 GROQ_API_KEY' });
  }
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ ok: false, error: '缺少 prompt' });
    const dayMatch = prompt.match(/(\d+)\s*天/);
    const totalDays = dayMatch ? parseInt(dayMatch[1], 10) : 0;
    const CHUNK_THRESHOLD = 5;
    const CHUNK_SIZE = 4;
    // [PATCH-C] 給 chunking 一個明確的 maxTokens 預算（16000）。
    // 配合 PATCH-A/B：能傳得進去、不會被 Groq 端腰斬。
    const CHUNK_MAX_TOKENS = 16000;
    if (totalDays >= CHUNK_THRESHOLD) {
      const chunks = [];
      for (let s = 1; s <= totalDays; s += CHUNK_SIZE) {
        chunks.push({ start: s, end: Math.min(s + CHUNK_SIZE - 1, totalDays) });
      }
      console.log(`[Chunk] ${totalDays} 天 → ${chunks.length} 塊（每塊最多 ${CHUNK_SIZE} 天，maxTokens=${CHUNK_MAX_TOKENS}）`);
      const itinerary = [];
      const usedNames = new Set();
      let firstMeta = null;
      let usedProvider = null;
      let usedModel = null;
      // [NEW] 蒐集每塊的狀態，最後一起回給前端，讓 UI 能標紅「Day 9-11 不完整，請重試」
      const chunkWarnings = [];
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
- 每個 itinerary 物件**必須**有非空 theme、region 字串；activities 陣列要有具體活動（至少 4 個）
- 每個活動必須填齊 name（非空）、type、以及（SIGHTSEEING/FOOD/ACTIVITY/SHOPPING 類）coordinates {lat: 數字, lng: 數字}
- ${isFirst ? '頂層欄位（tripTitle、overview、advice、packingList）正常輸出豐富內容' : '頂層欄位（tripTitle、overview、advice、packingList）可填空字串或空陣列以節省 token'}
- 仍然遵守規則 A/B/C：每天必須完整、每個活動必須具體精準
- 【本塊內也嚴禁重複】此塊第 ${start}-${end} 天的 SIGHTSEEING/FOOD/ACTIVITY/SHOPPING 類 activity.name 必須兩兩不同。HOTEL 類例外可重複。${exclusionBlock}`;
        console.log(`[Chunk] ${i + 1}/${chunks.length}: days ${start}-${end}, exclude=${usedNames.size}`);
        let result;
        let parsed;
        // [PATCH-修D] MAX_LEN_RETRY 從 1 提高到 2，多一次補救機會
        const MAX_LEN_RETRY = 2;
        let lastIssues = [];
        for (let attempt = 0; attempt <= MAX_LEN_RETRY; attempt++) {
          const gotSoFar = parsed?.itinerary?.length ?? 0;
          const dayShortageNag = (attempt > 0 && gotSoFar < chunkDays)
            ? `\n\n【上一次嘗試只回了 ${gotSoFar} 天，但本塊需要 ${chunkDays} 天】請務必這次的 itinerary 陣列剛好 ${chunkDays} 個元素，dayNumber 從 ${start} 到 ${end}，每天 6+ 個活動（其中 SIGHTSEEING 至少 3 個）。不可只回一天就停。`
            : '';
          const sightNag = attempt > 0 ? buildSightseeingNag(findSightseeingShortfall(parsed)) : '';
          // [PATCH-D] 把上次驗到的結構問題回灌給 prompt，要求模型修正
          const incompleteNag = attempt > 0 ? buildIncompleteNag(lastIssues) : '';
          result = await callLLMWithRetry(
            chunkPrompt + dayShortageNag + sightNag + incompleteNag,
            `Chunk ${i + 1}${attempt > 0 ? ` retry${attempt}` : ''}`,
            CHUNK_MAX_TOKENS, // [PATCH-A/C] 明確傳 maxTokens
          );
          parsed = extractJSON(result.text, result.truncated);
          if (!parsed) {
            // JSON 完全壞掉，retry 還能補救
            if (attempt < MAX_LEN_RETRY) {
              console.warn(`[Chunk] ${i + 1} attempt ${attempt + 1}: JSON 解析失敗，重試`);
              continue;
            }
            throw new Error(`Chunk ${i + 1} (days ${start}-${end}) JSON 解析失敗`);
          }
          const got = Array.isArray(parsed.itinerary) ? parsed.itinerary.length : 0;
          const shorts = findSightseeingShortfall(parsed);
          // [PATCH-D] 主驗證：結構完整性
          const issues = findIncompleteFields(parsed, start, end);
          lastIssues = issues;
          if (got >= chunkDays && shorts.length === 0 && issues.length === 0) break;
          console.warn(`[Chunk] ${i + 1} attempt ${attempt + 1}: 天數=${got}/${chunkDays}, sightseeing 缺=${shorts.length}, 結構問題=${issues.length}${attempt < MAX_LEN_RETRY ? '，重試' : '，放棄'}`);
          if (issues.length > 0) {
            console.warn(`[Chunk] ${i + 1} 結構問題前 5：${issues.slice(0, 5).join(' | ')}`);
          }
        }
        if (Array.isArray(parsed.itinerary)) {
          if (parsed.itinerary.length !== chunkDays) {
            console.warn(`[Chunk] ${i + 1} 最終天數仍異常：要求 ${chunkDays} 天，得 ${parsed.itinerary.length} 天`);
          }
          for (const day of parsed.itinerary) {
            if (Array.isArray(day.activities)) {
              for (const act of day.activities) {
                if (act?.name && act?.type !== 'HOTEL') usedNames.add(act.name);
              }
            }
          }
          itinerary.push(...parsed.itinerary);
        } else {
          console.error(`[Chunk] ${i + 1} 沒有 itinerary 陣列`);
        }
        // [PATCH-D/觀測性] 紀錄本塊最終狀態
        const finalIssues = findIncompleteFields(parsed, start, end);
        const isClean = finalIssues.length === 0;
        recordChunkOutcome(i, isClean);
        if (!isClean) {
          recordChunkIncomplete(i, start, end, finalIssues);
          chunkWarnings.push({
            chunkIndex: i + 1,
            days: `${start}-${end}`,
            issueCount: finalIssues.length,
            issues: finalIssues.slice(0, 10),
          });
        }
        if (isFirst) {
          firstMeta = parsed;
          usedProvider = result.provider;
          usedModel = result.model;
        }
      }
      const merged = { ...firstMeta, itinerary };
      const allNames = itinerary.flatMap(d => (d.activities || []).filter(a => a?.type !== 'HOTEL').map(a => a.name).filter(Boolean));
      const counts = new Map();
      for (const n of allNames) counts.set(n, (counts.get(n) || 0) + 1);
      const dups = [...counts.entries()].filter(([, c]) => c > 1);
      if (dups.length > 0) {
        console.warn(`[Chunk] 合併後仍有 ${dups.length} 個非 HOTEL 重複 name：${dups.map(([n, c]) => `${n}×${c}`).join('、')}`);
      }
      console.log(`[Chunk] 合併完成：${itinerary.length} 天, 非 HOTEL 唯一活動 ${counts.size}/${allNames.length}`);
      const suspects = annotateSuspectFood(merged);
      if (suspects.length > 0) {
        console.warn(`[Food] ${suspects.length} 個可疑 FOOD name：${suspects.join('、')}`);
      }
      stats.generate.ok++;
      // [PATCH-外露] 把 chunkWarnings 回給前端
      return res.json({
        ok: true,
        text: JSON.stringify(merged),
        provider: usedProvider,
        model: usedModel,
        chunked: true,
        totalDays: itinerary.length,
        chunkCount: chunks.length,
        suspectFoodCount: suspects.length,
        chunkWarnings: chunkWarnings.length > 0 ? chunkWarnings : undefined,
      });
    }
    // 單次呼叫（≤4 天）— 含 SIGHTSEEING 驗證重試
    let parsed = null;
    let provider, model, text, finishReason;
    const SINGLE_MAX_RETRY = 1;
    for (let attempt = 0; attempt <= SINGLE_MAX_RETRY; attempt++) {
      const sightNag = attempt > 0 ? buildSightseeingNag(findSightseeingShortfall(parsed)) : '';
      ({ provider, model, text, finishReason } = await callLLM(prompt + sightNag));
      parsed = extractJSON(text);
      if (!parsed) break;
      const shorts = findSightseeingShortfall(parsed);
      if (shorts.length === 0) break;
      if (attempt < SINGLE_MAX_RETRY) {
        console.warn(`[Sightseeing] 重試：${shorts.map(s => `Day${s.dayNumber}=${s.count}`).join(',')}`);
      } else {
        console.warn(`[Sightseeing] 重試後仍不足：${shorts.map(s => `Day${s.dayNumber}=${s.count}`).join(',')}`);
      }
    }
    if (parsed) {
      const suspects = annotateSuspectFood(parsed);
      if (suspects.length > 0) console.warn(`[Food] ${suspects.length} 個可疑 FOOD name：${suspects.join('、')}`);
      stats.generate.ok++;
      return res.json({ ok: true, text: JSON.stringify(parsed), provider, model, suspectFoodCount: suspects.length });
    }
    stats.generate.fail++;
    console.error(`[API] JSON 解析失敗。provider: ${provider}, 模型: ${model}, 原因: ${finishReason}`);
    console.error(`[API] 前 500 字: ${text.substring(0, 500)}`);
    res.status(500).json({
      ok: false,
      error: `AI 回傳了非 JSON 內容（${provider}/${model}）。請重試一次。`,
      preview: text.substring(0, 300),
    });
  } catch (e) {
    stats.generate.fail++;
    res.status(500).json({ ok: false, error: e.message, details: e.details || null });
  }
});
// ── 除錯：只跑 Gemini，回傳每個 model 的原始錯誤 ─────────────
app.get('/api/debug-gemini', async (req, res) => {
  const keyPresent = !!API_KEY;
  const keyPreview = API_KEY ? `${API_KEY.slice(0, 4)}…${API_KEY.slice(-4)} (len=${API_KEY.length})` : null;
  try {
    const r = await callGemini('回傳 JSON：{"status":"ok"}。只要 JSON。', 128);
    res.json({ keyPresent, keyPreview, result: r });
  } catch (e) {
    res.json({ keyPresent, keyPreview, error: e.message, stack: (e.stack || '').split('\n').slice(0, 5) });
  }
});
app.post('/api/debug-gemini', async (req, res) => {
  const prompt = req.body?.prompt;
  if (!prompt) return res.status(400).json({ ok: false, error: '缺少 prompt' });
  try {
    const r = await callGemini(prompt, req.body?.maxTokens);
    res.json({
      ok: r.ok,
      provider: r.provider,
      model: r.model,
      finishReason: r.finishReason,
      textLength: r.text?.length ?? 0,
      textPreview: r.text ? r.text.substring(0, 200) : null,
      errors: r.errors || [],
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
// ── Keep-alive ping（不打 LLM，安全給 UptimeRobot 等 cron 喚醒服務用）─
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});
// ── /api/stats 看流量與哪個模型接了 ─────────────────────────
app.get('/api/stats', (req, res) => {
  const uptimeMin = Math.floor((Date.now() - stats.startedAt) / 60000);
  res.json({
    ok: true,
    uptimeMinutes: uptimeMin,
    generate: stats.generate,
    suggest: stats.suggest,
    modelHits: stats.modelHits,
    modelFails: stats.modelFails,
    lastFailures: stats.lastFailures,
    quotaCooldownMinutes: cooldownSnapshot(),
    // [NEW] 加上 chunk 觀測性
    chunkOutcomes: stats.chunkOutcomes,
    chunkIncomplete: stats.chunkIncomplete,
  });
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
    const status = GROQ_MODELS.map(id => ({ id, available: available.includes(id), outputCap: GROQ_OUTPUT_LIMITS[id] || 8000 }));
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
      stats.suggest.ok++;
      return res.json({ ok: true, suggestions: parsed });
    }
    stats.suggest.fail++;
    res.json({ ok: false, error: '無法解析推薦結果' });
  } catch (e) {
    stats.suggest.fail++;
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
  console.log(`🧩 Chunking：≥5 天自動拆成 4 天/塊，maxTokens=16000，含結構驗證與 2 次重試`);
  console.log(`🔧 測試：/api/test | 除錯：/api/debug-generate | 觀測：/api/stats\n`);
});
