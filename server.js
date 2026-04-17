const express = require('express');
const axios   = require('axios');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

// ── Claude API 代理 ──────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ ok: false, error: '伺服器未設定 ANTHROPIC_API_KEY' });
  }

  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ ok: false, error: '缺少 prompt' });

    const { data } = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }],
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      timeout: 120000,
    });

    const text = (data.content || []).map(b => b.text || '').join('');
    res.json({ ok: true, text });
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message || '未知錯誤';
    console.error('[generate]', msg);
    res.status(500).json({ ok: false, error: msg });
  }
});

app.listen(PORT, () => {
  console.log(`\n🗾  Japan Travel Planner`);
  console.log(`📡  http://localhost:${PORT}`);
  console.log(`🔑  API Key: ${API_KEY ? '已設定 ✅' : '❌ 未設定（請設定 ANTHROPIC_API_KEY）'}\n`);
});
