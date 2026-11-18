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

  // POST 응답에서 에러 메시지 패턴 찾기
  const serverError = (postHtml.match(/(?:class="[^"]*(?:error|alert|msg|message|notice)[^"]*")[^>]*>([^<]{5,200})</i) || [])[1] || '';
  // POST 응답 본문 중간 부분 (로그인 에러 메시지가 있을 위치)
  const loginFormArea = (() => {
    const idx = postHtml.indexOf('usrId');
    return idx > -1 ? postHtml.substring(Math.max(0, idx - 300), idx + 300) : '';
  })();

  res.json({
    getStatus: getRes.status,
    formTags,
    allInputs: allInputs.map(i => i.name),
    postStatus: postRes.status,
    postUrl: postRes.url,
    serverError,
    loginFormArea,
    credId: cred.id,
  });
};
