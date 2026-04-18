const express = require('express');
const axios   = require('axios');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY || '';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

// ── Gemini API 代理（免費）──────────────────────────────────
// 模型優先順序：2.5-flash（最新）→ 2.0-flash（備用）
// 注意：1.5 系列已於 2026 年被 Google 關閉
app.post('/api/generate', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ ok: false, error: '伺服器未設定 GEMINI_API_KEY' });
  }

  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ ok: false, error: '缺少 prompt' });

    const models = [
      'gemini-2.5-flash',       // 最新免費模型（推薦）
      'gemini-2.0-flash',       // 備用
      'gemini-2.5-flash-lite',  // 輕量備用
    ];
    let lastError = '';

    for (const model of models) {
      try {
        console.log(`[generate] 嘗試 ${model}...`);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;
        
        const { data } = await axios.post(url, {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 8192,
            responseMimeType: 'application/json',
          },
        }, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 120000,
        });

        const text = data.candidates?.[0]?.content?.parts
          ?.map(p => p.text || '').join('') || '';

        if (!text) {
          lastError = `${model}: AI 回應為空`;
          console.error(lastError);
          continue;
        }

        console.log(`[generate] ${model} 成功，回傳 ${text.length} 字`);
        return res.json({ ok: true, text });
      } catch (e) {
        lastError = `${model}: ${e.response?.data?.error?.message || e.message || '未知錯誤'}`;
        console.error(`[generate]`, lastError);
      }
    }

    res.status(500).json({ ok: false, error: lastError });
  } catch (e) {
    const msg = e.message || '未知錯誤';
    console.error('[generate]', msg);
    res.status(500).json({ ok: false, error: msg });
  }
});

app.listen(PORT, () => {
  console.log(`\n🗾  Japan Travel Planner (Gemini Free)`);
  console.log(`📡  http://localhost:${PORT}`);
  console.log(`🔑  Gemini Key: ${API_KEY ? '已設定 ✅' : '❌ 未設定（請設定 GEMINI_API_KEY）'}`);
  console.log(`📌  模型：gemini-2.5-flash（免費）\n`);
});
