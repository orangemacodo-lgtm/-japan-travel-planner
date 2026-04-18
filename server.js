const express = require('express');
const axios   = require('axios');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY || '';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

// ── Gemini API 代理（免費）──────────────────────────────────
app.post('/api/generate', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ ok: false, error: '伺服器未設定 GEMINI_API_KEY' });
  }

  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ ok: false, error: '缺少 prompt' });

    // 嘗試 gemini-2.0-flash（免費額度最高），失敗則用 1.5-flash
    const models = ['gemini-2.0-flash', 'gemini-1.5-flash'];
    let lastError = '';

    for (const model of models) {
      try {
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

        // 從 Gemini 回應中提取文字
        const text = data.candidates?.[0]?.content?.parts
          ?.map(p => p.text || '').join('') || '';

        if (!text) {
          lastError = 'AI 回應為空';
          continue;
        }

        console.log(`[generate] ${model} 成功，回傳 ${text.length} 字`);
        return res.json({ ok: true, text });
      } catch (e) {
        lastError = e.response?.data?.error?.message || e.message || '未知錯誤';
        console.error(`[${model}]`, lastError);
      }
    }

    res.status(500).json({ ok: false, error: lastError });
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message || '未知錯誤';
    console.error('[generate]', msg);
    res.status(500).json({ ok: false, error: msg });
  }
});

app.listen(PORT, () => {
  console.log(`\n🗾  Japan Travel Planner (Gemini Free)`);
  console.log(`📡  http://localhost:${PORT}`);
  console.log(`🔑  Gemini Key: ${API_KEY ? '已設定 ✅' : '❌ 未設定（請設定 GEMINI_API_KEY）'}\n`);
});
