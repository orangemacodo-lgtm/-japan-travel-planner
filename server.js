const express = require('express');
const axios   = require('axios');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY || '';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

// ── 從 Gemini 回應中提取 JSON ────────────────────────────────
function extractJSON(text) {
  if (!text) return null;
  
  // 1. 嘗試直接解析（最理想情況）
  try { return JSON.parse(text.trim()); } catch (_) {}
  
  // 2. 移除 markdown code block 包裹
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1].trim()); } catch (_) {}
  }
  
  // 3. 找最大的 {...} 區塊
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try { return JSON.parse(braceMatch[0]); } catch (_) {}
    
    // 4. JSON 可能被截斷，嘗試修復
    let json = braceMatch[0];
    // 找最後一個完整的 activity 或 day
    const lastBracket = json.lastIndexOf(']');
    if (lastBracket > 0) {
      // 嘗試在最後的 ] 後面補上必要的 } 來關閉
      for (let i = 0; i < 5; i++) {
        try { return JSON.parse(json.substring(0, lastBracket + 1) + '}'.repeat(i + 1)); } catch (_) {}
      }
    }
  }
  
  return null;
}

// ── Gemini API 呼叫 ─────────────────────────────────────────
async function callGemini(prompt) {
  const models = [
    'gemini-2.5-flash',
    'gemini-2.0-flash', 
    'gemini-2.5-flash-lite',
  ];

  for (const model of models) {
    try {
      console.log(`[AI] 嘗試 ${model}...`);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;
      
      const body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 8192,
        },
      };

      // gemini-2.5-flash 支援 JSON mode，但要關閉思考模式
      if (model.includes('2.5')) {
        body.generationConfig.responseMimeType = 'application/json';
        // 關閉思考模式，避免輸出思考過程
        body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
      }

      const { data } = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 120000,
      });

      // 提取文字（可能在 parts 中有多個 part）
      const parts = data.candidates?.[0]?.content?.parts || [];
      const text = parts.map(p => p.text || '').join('');

      if (!text) {
        console.error(`[AI] ${model}: 回應為空`);
        continue;
      }

      console.log(`[AI] ${model} 成功，回傳 ${text.length} 字`);
      return { model, text };
    } catch (e) {
      const msg = e.response?.data?.error?.message || e.message;
      console.error(`[AI] ${model} 失敗: ${msg}`);
    }
  }

  throw new Error('所有模型都失敗了，請稍後再試');
}

// ── 主 API ───────────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ ok: false, error: '伺服器未設定 GEMINI_API_KEY' });
  }

  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ ok: false, error: '缺少 prompt' });

    const { model, text } = await callGemini(prompt);
    
    // 嘗試解析 JSON
    const parsed = extractJSON(text);
    if (parsed) {
      // 直接回傳解析後的 JSON 字串（確保格式正確）
      return res.json({ ok: true, text: JSON.stringify(parsed) });
    }

    // 解析失敗，回傳原始文字讓前端嘗試
    console.warn(`[API] JSON 解析失敗，回傳原始文字（前 200 字）: ${text.substring(0, 200)}`);
    res.json({ ok: true, text });
  } catch (e) {
    console.error('[API]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── 除錯用：測試 API 是否正常 ────────────────────────────────
app.get('/api/test', async (req, res) => {
  if (!API_KEY) {
    return res.json({ ok: false, error: '未設定 GEMINI_API_KEY', keyLength: 0 });
  }

  try {
    const { model, text } = await callGemini(
      '回傳一個簡單的 JSON：{"status":"ok","message":"連線成功"}，只要 JSON，不要其他文字。'
    );
    
    const parsed = extractJSON(text);
    res.json({
      ok: true,
      model,
      rawLength: text.length,
      rawPreview: text.substring(0, 300),
      parsed,
      jsonExtractOk: !!parsed,
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🗾  Japan Travel Planner (Gemini Free)`);
  console.log(`📡  http://localhost:${PORT}`);
  console.log(`🔑  Gemini Key: ${API_KEY ? '已設定 ✅' : '❌ 未設定'}`);
  console.log(`📌  模型：gemini-2.5-flash → 2.0-flash → 2.5-flash-lite`);
  console.log(`🔧  除錯：${`http://localhost:${PORT}/api/test`}\n`);
});
