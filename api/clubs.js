const { kv } = require('@vercel/kv');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const clubs = await kv.get('clubs') || {};
    // Mask passwords
    const masked = {};
    for (const [k, v] of Object.entries(clubs)) {
      masked[k] = { id: v.id, hasPw: !!v.pw };
    }
    return res.json(masked);
  }

  if (req.method === 'POST') {
    const { club, id, pw } = req.body;
    if (!club || !id || !pw) return res.status(400).json({ error: '입력값 오류' });
    const clubs = await kv.get('clubs') || {};
    clubs[club] = { id, pw };
    await kv.set('clubs', clubs);
    return res.json({ ok: true });
  }

  res.status(405).end();
};
