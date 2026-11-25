process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { kv } = require('@vercel/kv');
const fetch = require('node-fetch');
const { CookieJar } = require('tough-cookie');
const _fc = require('fetch-cookie');
const makeFetchCookie = typeof _fc === 'function' ? _fc : _fc.default;

const BASE = 'https://www.shinangolf.com/biz/';
const PHONE = process.env.SINAN_PHONE || '010-5313-8084';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const KV_SESSION_KEY = 'sinan-otp-session';

// sn=리베라CC(71), sa=신안CC(75), gh=그린힐CC(70), wh=웰리힐리(미지원)
const CLUB_CODE = { sn: '71', sa: '75', gh: '70' };

function extractCsrf(html) {
  const m = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/) ||
            html.match(/csrf_token['"]\s*:\s*['"]([^'"]+)['"]/);
  return m ? m[1] : '';
}

function getCalDate() {
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth() + 2, 1);
  return `${target.getFullYear()}${String(target.getMonth() + 1).padStart(2, '0')}01`;
}

function hdrs(extra = {}) {
  return { 'User-Agent': UA, ...extra };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { action, otp, items } = req.body || {};

  try {
    // ── STEP 1: OTP 발송 ──────────────────────────────
    if (action === 'request-otp') {
      const jar = new CookieJar();
      const fetchC = makeFetchCookie(fetch, jar);

      const pageRes = await fetchC(BASE, { headers: hdrs({ Accept: 'text/html,*/*' }) });
      const pageHtml = await pageRes.text();
      const csrf = extractCsrf(pageHtml);
      if (!csrf) return res.status(500).json({
        error: 'CSRF 토큰을 찾을 수 없습니다',
        status: pageRes.status,
        url: pageRes.url,
        htmlPreview: pageHtml.substring(0, 400)
      });

      const smsBody = new URLSearchParams({ msPhone: PHONE, csrf_token: csrf });
      const smsRes = await fetchC(`${BASE}smsCheck`, {
        method: 'POST',
        headers: hdrs({ 'Content-Type': 'application/x-www-form-urlencoded', Referer: BASE, Origin: 'https://www.shinangolf.com' }),
        body: smsBody.toString()
      });
      const smsData = await smsRes.json();
      if (smsData.code !== '1') return res.status(400).json({ error: smsData.msg || 'OTP 발송 실패' });

      // 세션 직렬화 → KV 저장 (유효기간 내)
      const jarSerialized = jar.serializeSync();
      await kv.set(KV_SESSION_KEY, { csrf, jar: jarSerialized }, { ex: (smsData.expire || 180) + 10 });

      return res.json({ ok: true, expire: smsData.expire || 180, msg: smsData.msg });
    }

    // ── STEP 2: OTP 검증 + 로그인 + 접수 ────────────
    if (action === 'submit') {
      if (!otp) return res.status(400).json({ error: '인증번호가 필요합니다' });
      if (!items || !items.length) return res.status(400).json({ error: '접수 항목이 없습니다' });

      const session = await kv.get(KV_SESSION_KEY);
      if (!session) return res.status(400).json({ error: '세션 만료. OTP를 다시 요청하세요.' });

      const jar = CookieJar.deserializeSync(session.jar);
      const fetchC = makeFetchCookie(fetch, jar);

      // 최신 CSRF 갱신
      const page2Res = await fetchC(BASE, { headers: hdrs() });
      const page2Html = await page2Res.text();
      const csrf2 = extractCsrf(page2Html) || session.csrf;

      // OTP 검증
      const certBody = new URLSearchParams({ serNum: String(otp).trim(), csrf_token: csrf2 });
      const certRes = await fetchC(`${BASE}certCheck`, {
        method: 'POST',
        headers: hdrs({ 'Content-Type': 'application/x-www-form-urlencoded', Referer: BASE, Origin: 'https://www.shinangolf.com' }),
        body: certBody.toString()
      });
      const certData = await certRes.json();
      if (certData.code !== '1') return res.status(400).json({ error: `OTP 검증 실패: ${certData.msg}` });

      // 세션 로그인
      const loginBody = new URLSearchParams({ csrf_token: csrf2 });
      await fetchC(`${BASE}authProc`, {
        method: 'POST',
        headers: hdrs({ 'Content-Type': 'application/x-www-form-urlencoded', Referer: BASE, Origin: 'https://www.shinangolf.com' }),
        body: loginBody.toString()
      });

      await kv.del(KV_SESSION_KEY);

      // 각 항목 접수
      const results = [];
      const calDate = getCalDate();

      for (const item of items) {
        const { key, date, c1, c2, c3, timeS, timeE } = item;

        if (!CLUB_CODE[c1]) {
          results.push({ key, success: false, error: `${c1} 클럽은 신안그룹 사전접수 미지원` });
          continue;
        }

        try {
          const metroRes = await fetchC(`${BASE}metro`, {
            headers: hdrs({ Referer: `${BASE}main` })
          });
          const metroHtml = await metroRes.text();

          if (metroRes.url && metroRes.url.includes('main') && !metroRes.url.includes('metro')) {
            results.push({ key, success: false, error: '세션 만료' });
            break;
          }

          const metroCsrf = extractCsrf(metroHtml);
          const dateStr = (date || '').replace(/-/g, '');

          const saveBody = new URLSearchParams({
            calDate,
            waitDay:    dateStr,
            waitCodiv1: CLUB_CODE[c1] || '71',
            waitCodiv2: CLUB_CODE[c2] || '75',
            waitCodiv3: CLUB_CODE[c3] || '70',
            waitTimeS:  timeS || '09',
            waitTimeE:  timeE || '12',
            waitRemark: '',
            csrf_token: metroCsrf
          });

          const saveRes = await fetchC(`${BASE}waitSave`, {
            method: 'POST',
            headers: hdrs({ 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${BASE}metro`, Origin: 'https://www.shinangolf.com' }),
            body: saveBody.toString()
          });
          const saveHtml = await saveRes.text();
          const finalUrl = saveRes.url || '';

          const isSuccess = saveHtml.includes('신청이 완료') || saveHtml.includes('접수되었') ||
            saveHtml.includes('신청되었') || saveHtml.includes('waitSeq') ||
            finalUrl.includes('metro') || finalUrl.includes('main');

          const isFailed = saveHtml.includes('이미') || saveHtml.includes('중복') || saveHtml.includes('마감');

          if (isFailed) {
            results.push({ key, success: false, error: '이미 접수 or 마감' });
          } else if (isSuccess) {
            results.push({ key, success: true });
          } else {
            results.push({ key, success: false, error: '결과 불명확' });
          }
        } catch (e) {
          results.push({ key, success: false, error: e.message });
        }
      }

      return res.json({ ok: true, results });
    }

    return res.status(400).json({ error: '잘못된 action' });
  } catch (err) {
    console.error('[sinan-baejung]', err.message, err.stack);
    return res.status(500).json({ error: err.message });
  }
};
