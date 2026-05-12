# Test scripts

Manual verification scripts that hit production https://japan-travel-planner-orui.onrender.com/.

| Script | Purpose |
|---|---|
| `probe.js` | Tiny heavy-prompt probe — does the LLM chain currently respond? Exits 0 on success. |
| `test_dedup.js` | Full 10-day Osaka/Kyoto trip, mirrors UI prompt. Reports day count, non-HOTEL dedup, fake-name detector. |
| `test_5day.js` | Same checks at 5-day length (no chunking path). |
| `test_nav.js` | 3-day trip that dumps every activity's coords + travelToNext to verify the 導航 button conditions hold. |
| `test_coords.js` | Minimal 3-day prompt that just checks coordinates are not 0/0 or duplicated. |

Each script burns ~5-15K Groq tokens. Don't spam — TPD is 100K per model per day per free tier.

Run from repo root:
```bash
node scripts/test_dedup.js
node scripts/test_5day.js
```

Each script's prompt is self-contained — they don't read the live frontend, so update them when `public/index.html`'s prompt changes.
