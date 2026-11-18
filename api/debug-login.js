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

  // form 태그 정보 추출
  const allInputs = [...getHtml.matchAll(/<input[^>]+name=["']([^"']+)["'][^>]*>/gi)].map(m => ({ html: m[0], name: m[1] }));
  const formTags = [...getHtml.matchAll(/<form[^>]*>/gi)].map(m => m[0]);
  // 오류 메시지 추출
  const errorMsg = (postHtml.match(/alert\(['"]([^'"]{5,100})['"]\)/i) || [])[1] || '';
  const postAlerts = [...postHtml.matchAll(/alert\(['"]([^'"]+)['"]\)/gi)].map(m => m[1]);

  // GET 쿠키 확인
  const cookies = jar.toJSON().cookies.map(c => `${c.key}=${c.value.substring(0,10)}`);

  // 응답 헤더 확인
  const postHeaders = {};
  for (const [k, v] of postRes.headers.entries()) {
    if (['location', 'set-cookie', 'content-type'].includes(k.toLowerCase())) {
      postHeaders[k] = v;
    }
  }

  // POST 응답 길이와 타입
  const postContentLength = postHtml.length;
  const hasLoginForm = postHtml.includes('name="mainForm"');
  const hasErrorText = postHtml.includes('아이디가 올바르지') || postHtml.includes('비밀번호가 올바르지') || postHtml.includes('일치하지 않');

  res.json({
    credId: cred.id,
    cookiesAfterGet: cookies,
    postStatus: postRes.status,
    postUrl: postRes.url,
    postHeaders,
    postContentLength,
    hasLoginForm,
    hasErrorText,
  });
};
