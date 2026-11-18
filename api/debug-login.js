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

  // POST login
  const postRes = await fetchC(`${BASE}/member/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': `${BASE}/member/login`,
      'Origin': BASE,
    },
    body: new URLSearchParams({
      returnURL: '/reservation/golf',
      usrId: cred.id,
      usrPwd: cred.pw,
      rememberId: '',
      rememberPwd: '',
    }).toString(),
    redirect: 'follow',
  });

  const postHtml = await postRes.text();

  // hidden 필드 추출
  const hiddenFields = [...getHtml.matchAll(/<input[^>]+type=["']hidden["'][^>]*>/gi)].map(m => m[0]);
  const formAction = (getHtml.match(/<form[^>]+action=["']([^"']+)["']/i) || [])[1];
  // 오류 메시지 추출
  const errorMsg = (postHtml.match(/alert\(['"]([^'"]{5,100})['"]\)/i) || [])[1] || '';
  const alertMsg = (postHtml.match(/(?:경고|오류|error|invalid|fail)[^<]{0,200}/i) || [])[0] || '';

  res.json({
    getStatus: getRes.status,
    getUrl: getRes.url,
    formAction,
    hiddenFields,
    postStatus: postRes.status,
    postUrl: postRes.url,
    postHasUsrId: postHtml.includes('usrId'),
    postHasUsrPwd: postHtml.includes('usrPwd'),
    errorMsg,
    alertMsg,
    credId: cred.id,
  });
};
