const fetch = require('node-fetch');
const { CookieJar } = require('tough-cookie');
const _fc = require('fetch-cookie');
const makeFetchCookie = typeof _fc === 'function' ? _fc : _fc.default;

const BASE = 'https://lakewood.co.kr';

async function bookLakewood({ id, pw }, booking) {
  const jar = new CookieJar();
  const fetchC = makeFetchCookie(fetch, jar);

  // 1. Login page GET (JSESSIONID 쿠키 초기화)
  await fetchC(`${BASE}/member/login`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9',
    },
  });

  // 2. AJAX 로그인 POST (/member/loginChk)
  const loginRes = await fetchC(`${BASE}/member/loginChk`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': `${BASE}/member/login`,
      'Origin': BASE,
    },
    body: new URLSearchParams({
      returnURL: '/reservation/golf',
      usrId: id,
      usrPwd: pw,
      rememberId: '',
      rememberPwd: '',
    }).toString(),
  });

  const loginData = await loginRes.json().catch(() => null);
  if (!loginData || loginData.success !== 'S') {
    const msg = loginData ? (loginData.returnMsg || '로그인 실패') : '로그인 응답 오류';
    throw new Error(msg);
  }

  // 2. Get reservation page (session init)
  await fetchC(`${BASE}/reservation/golf`, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': `${BASE}/` },
  });

  // 3. Get time list for target date
  const dateKey = booking.date.replace(/-/g, ''); // YYYYMMDD
  const timesRes = await fetchC(`${BASE}/reservation/ajax/golfTimeList`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `${BASE}/reservation/golf`,
      'User-Agent': 'Mozilla/5.0',
    },
    body: new URLSearchParams({
      bookgDate: dateKey,
      tabCourse: 'ALL',
    }).toString(),
  });

  const timesData = await timesRes.json().catch(() => null);
  if (!timesData || !timesData.golfTimeList || timesData.golfTimeList.length === 0) {
    throw new Error(`${booking.date} 예약 가능한 타임이 없습니다`);
  }

  // 4. Filter by time range if specified (timeFrom/timeTo in "HH:MM" format)
  let eligibleSlots = timesData.golfTimeList.filter(s => s.bookgTime);
  if (booking.timeFrom && booking.timeTo) {
    const toMins = t => parseInt(t.slice(0,2)) * 60 + parseInt(t.slice(2,4));
    const fromF = booking.timeFrom.replace(':', '');
    const toF   = booking.timeTo.replace(':', '');
    const fromMins = toMins(fromF.padEnd(4,'0'));
    const endMins  = toMins(toF.padEnd(4,'0'));
    eligibleSlots = eligibleSlots.filter(s => {
      const m = toMins(s.bookgTime);
      return m >= fromMins && m <= endMins;
    });
    if (eligibleSlots.length === 0) {
      throw new Error(`${booking.date} ${booking.timeFrom}~${booking.timeTo} 시간대에 예약 가능한 타임이 없습니다`);
    }
  }

  // 5. Find closest time to booking.time within eligible slots
  const [wantH, wantM] = booking.time.split(':').map(Number);
  const wantMins = wantH * 60 + wantM;

  let best = null;
  let minDiff = Infinity;

  for (const slot of eligibleSlots) {
    const t = slot.bookgTime;
    const h = parseInt(t.slice(0, 2));
    const m = parseInt(t.slice(2, 4));
    const totalMins = h * 60 + m;
    const diff = Math.abs(totalMins - wantMins);
    if (diff < minDiff) {
      minDiff = diff;
      best = slot;
    }
  }

  if (!best) throw new Error('적합한 타임을 찾지 못했습니다');

  // 5. Submit booking
  const submitRes = await fetchC(`${BASE}/reservation/ajax/golfSubmit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `${BASE}/reservation/golf`,
      'User-Agent': 'Mozilla/5.0',
    },
    body: new URLSearchParams({
      bookgDate: dateKey,
      bookgTime: best.bookgTime,
      bookgCourse: best.bookgCourse || '',
      bookgCourseNm: best.bookgCourseNm || '',
      bookgTimeDisp: best.bookgTimeDisp || best.bookgTime,
      bookgHole: best.bookgHole || '18',
      baseAmt: best.baseAmt || '0',
      dcAmt: best.dcAmt || '0',
      cancelBtn: best.cancelBtn || 'Y',
      selfTYn: best.selfTYn || 'N',
      macroChk: best.macroChk || '',
    }).toString(),
  });

  const submitData = await submitRes.json().catch(() => null);

  if (!submitData) throw new Error('예약 응답이 없습니다');
  if (submitData.result === 'FAIL' || submitData.errMsg) {
    throw new Error(submitData.errMsg || '예약 실패');
  }

  const timeDisp = `${best.bookgTime.slice(0,2)}:${best.bookgTime.slice(2,4)}`;
  return {
    time: timeDisp,
    course: best.bookgCourseNm || '',
    message: `${timeDisp} ${best.bookgCourseNm || ''} 예약 완료`,
  };
}

module.exports = { bookLakewood };
