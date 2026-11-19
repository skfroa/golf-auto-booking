const { kv } = require('@vercel/kv');
const fetch = require('node-fetch');
const { CookieJar } = require('tough-cookie');
const _fc = require('fetch-cookie');
const makeFetchCookie = typeof _fc === 'function' ? _fc : _fc.default;

const LK_BASE = 'https://lakewood.co.kr';
const EH_BASE = 'https://www.ehscc.co.kr';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Called by QStash:
//   lk: "59 0 * * *"  → 09:59 KST (00:59 UTC) — Lakewood opens 10:00 KST
//   eh: "59 23 * * *" → 08:59 KST (23:59 UTC) — Eunhwasam opens 09:00 KST
module.exports = async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const club = req.query.club || 'lk';

  const kstNow = new Date(Date.now() + 9 * 3600000);
  const todayStr = kstNow.toISOString().slice(0, 10);
  console.log(`[Warmup:${club}] ${todayStr} KST 시작`);

  const [bookings, clubs] = await Promise.all([
    kv.get('bookings').then(v => v || []),
    kv.get('clubs').then(v => v || {}),
  ]);

  const pending = bookings.filter(b =>
    b.status === 'pending' && b.club === club && b.openDate === todayStr
  );

  if (pending.length === 0) {
    console.log(`[Warmup:${club}] 오늘(${todayStr}) 오픈 예약 없음 → 스킵`);
    return res.json({ warmed: 0, message: `오늘 ${club} 오픈 예약 없음` });
  }

  const cred = clubs[club];
  if (!cred?.id || !cred?.pw) {
    console.error(`[Warmup:${club}] 자격증명 미설정`);
    return res.json({ warmed: 0, error: `${club} 자격증명 미설정` });
  }

  if (club === 'lk') {
    return warmupLakewood(res, cred, pending.length, todayStr);
  } else if (club === 'eh') {
    return warmupEunhwasam(res, cred, pending.length, todayStr);
  } else {
    return res.status(400).json({ error: `알 수 없는 club: ${club}` });
  }
};

async function warmupLakewood(res, cred, count, todayStr) {
  const jar = new CookieJar();
  const fetchC = makeFetchCookie(fetch, jar);

  await fetchC(`${LK_BASE}/member/login`, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'ko-KR,ko;q=0.9' },
  });

  const loginRes = await fetchC(`${LK_BASE}/member/loginChk`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': UA,
      'Referer': `${LK_BASE}/member/login`,
      'Origin': LK_BASE,
    },
    body: new URLSearchParams({ returnURL: '/reservation/golf', usrId: cred.id, usrPwd: cred.pw, rememberId: '', rememberPwd: '' }).toString(),
  });

  const loginData = await loginRes.json().catch(() => null);
  if (!loginData || loginData.success !== 'S') {
    const msg = loginData?.returnMsg || '로그인 실패';
    console.error(`[Warmup:lk] 로그인 실패: ${msg}`);
    return res.json({ warmed: 0, error: msg });
  }

  await fetchC(`${LK_BASE}/reservation/golf`, { headers: { 'User-Agent': UA, 'Referer': `${LK_BASE}/` } });

  const cookies = await jar.getCookies(LK_BASE);
  const cookieData = cookies.map(c => ({ key: c.key, value: c.value }));
  await kv.set('warmup:lk', JSON.stringify(cookieData), { ex: 90 });

  console.log(`[Warmup:lk] ✅ 세션 준비 완료 (쿠키 ${cookieData.length}개) — ${count}건 예약 대기중`);
  return res.json({ warmed: count, cookieCount: cookieData.length, message: '레이크우드 세션 준비 완료. 10:00 KST에 예약 실행 예정' });
}

async function warmupEunhwasam(res, cred, count, todayStr) {
  const jar = new CookieJar();
  const fetchC = makeFetchCookie(fetch, jar);

  // 1. GET login page
  await fetchC(`${EH_BASE}/Member/Login`, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
  });

  // 2. POST login
  const loginRes = await fetchC(`${EH_BASE}/Member/LoginAction`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': UA,
      'Referer': `${EH_BASE}/Member/Login`,
      'Origin': EH_BASE,
    },
    body: new URLSearchParams({ id: cred.id, pwd: cred.pw, saveID: 'N', savePwd: 'N', type: 'I' }).toString(),
  });

  const loginData = await loginRes.json().catch(() => null);
  if (!loginData || loginData.code !== '0') {
    const msg = loginData?.msg || '로그인 실패';
    console.error(`[Warmup:eh] 로그인 실패: ${msg}`);
    return res.json({ warmed: 0, error: msg });
  }

  // 3. GET GolfCalendar (session init + cookie prime)
  await fetchC(`${EH_BASE}/Booking/GolfCalendar`, {
    headers: { 'User-Agent': UA, 'Referer': EH_BASE },
  });

  const cookies = await jar.getCookies(EH_BASE);
  const cookieData = cookies.map(c => ({ key: c.key, value: c.value }));
  await kv.set('warmup:eh', JSON.stringify(cookieData), { ex: 90 });

  console.log(`[Warmup:eh] ✅ 세션 준비 완료 (쿠키 ${cookieData.length}개) — ${count}건 예약 대기중`);
  return res.json({ warmed: count, cookieCount: cookieData.length, message: '은화삼 세션 준비 완료. 09:00 KST에 예약 실행 예정' });
}
