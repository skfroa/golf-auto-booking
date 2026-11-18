const fetch = require('node-fetch');
const { CookieJar } = require('tough-cookie');
const _fc = require('fetch-cookie');
const makeFetchCookie = typeof _fc === 'function' ? _fc : _fc.default;
const { kv } = require('@vercel/kv');

const BASE = 'https://lakewood.co.kr';

module.exports = async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const clubs = await kv.get('clubs') || {};
  const cred = clubs['lk'];
  if (!cred) return res.json({ error: 'no credentials' });

  const jar = new CookieJar();
  const fetchC = makeFetchCookie(fetch, jar);

  // GET login page
  const getRes = await fetchC(`${BASE}/member/login`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  const getHtml = await getRes.text();

  // POST login (redirect: manual로 먼저 체크)
  const postRes = await fetchC(`${BASE}/member/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': `${BASE}/member/login`,
      'Origin': BASE,
    },
    body: new URLSearchParams({
      returnURL: '/',
      usrId: cred.id,
      usrPwd: cred.pw,
      rememberId: '',
      rememberPwd: '',
    }).toString(),
    redirect: 'manual',
  });

  const postHtml = await postRes.text().catch(() => '');

  // 응답 헤더 모두 수집
  const allPostHeaders = {};
  for (const [k, v] of postRes.headers.entries()) {
    allPostHeaders[k] = v.substring(0, 150);
  }

  res.json({
    credId: cred.id,
    postStatus: postRes.status,
    postUrl: postRes.url,
    allPostHeaders,
    postBodyLength: postHtml.length,
    postBodyFirst300: Buffer.from(postHtml.substring(0, 300)).toString('base64'),
  });
};
