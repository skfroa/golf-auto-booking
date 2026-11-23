const fetch = require('node-fetch');
const { CookieJar } = require('tough-cookie');
const _fc = require('fetch-cookie');
const makeFetchCookie = typeof _fc === 'function' ? _fc : _fc.default;

const BASE = 'https://lakewood.co.kr';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CH_UA = '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"';
const delay = ms => new Promise(r => setTimeout(r, ms));
const humanDelay = () => delay(100 + Math.floor(Math.random() * 400));

// warmSession: [{key, value}] cookie array pre-loaded at 09:59 KST by api/warmup.js
async function bookLakewood({ id, pw }, booking, warmSession = null) {
  const jar = new CookieJar();
  const fetchC = makeFetchCookie(fetch, jar);

  if (warmSession) {
    // 09:59에 준비된 세션 재사용 → 로그인 단계 생략, golfTimeList 직행
    await Promise.all(
      warmSession.map(c =>
        jar.setCookie(`${c.key}=${c.value}; Domain=lakewood.co.kr; Path=/`, BASE)
      )
    );
    console.log(`[Lakewood] 사전 세션 재사용 (쿠키 ${warmSession.length}개) → golfTimeList 직행`);
  } else {
    // 1. Login page GET (JSESSIONID 쿠키 초기화)
    await fetchC(`${BASE}/member/login`, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'sec-ch-ua': CH_UA,
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Cache-Control': 'max-age=0',
      },
    });

    // 2. AJAX 로그인 POST (/member/loginChk)
    const loginRes = await fetchC(`${BASE}/member/loginChk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': UA,
        'Accept': '*/*',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'sec-ch-ua': CH_UA,
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
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

    // 3. Get reservation page (session init)
    await fetchC(`${BASE}/reservation/golf`, {
      headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'sec-ch-ua': CH_UA,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
      'Referer': `${BASE}/`,
    },
    });
  }

  // 4. Get time list for target date
  const dateKey = booking.date.replace(/-/g, ''); // YYYYMMDD
  const timesRes = await fetchC(`${BASE}/reservation/ajax/golfTimeList`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': UA,
      'Accept': '*/*',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'sec-ch-ua': CH_UA,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'Referer': `${BASE}/reservation/golf`,
    },
    body: new URLSearchParams({
      bookgDate: dateKey,
      tabCourse: 'ALL',
    }).toString(),
  });

  // golfTimeList returns HTML fragment, not JSON.
  // Each bookable slot has: onclick="golfConfirm('bookgDate','bookgTime','bookgCourse',
  //   'bookgCourseNm','bookgTimeDisp','bookgHole','baseAmt','dcAmt','cancelBtn','selfTYn','macroChk')"
  const timesHtml = await timesRes.text();
  const slotRegex = /onclick="golfConfirm\(([^)]+)\)"/g;
  const slots = [];
  let slotMatch;
  while ((slotMatch = slotRegex.exec(timesHtml)) !== null) {
    const paramStr = slotMatch[1];
    const params = [];
    let cur = '', inStr = false, strCh = '';
    for (const ch of paramStr) {
      if (!inStr && (ch === "'" || ch === '"')) { inStr = true; strCh = ch; cur += ch; }
      else if (inStr && ch === strCh) { inStr = false; cur += ch; }
      else if (!inStr && ch === ',') { params.push(cur.trim().replace(/^['"]|['"]$/g, '')); cur = ''; }
      else { cur += ch; }
    }
    if (cur.trim()) params.push(cur.trim().replace(/^['"]|['"]$/g, ''));
    if (params.length >= 11) {
      slots.push({
        bookgDate:    params[0],
        bookgTime:    params[1],
        bookgCourse:  params[2],
        bookgCourseNm: params[3],
        bookgTimeDisp: params[4],
        bookgHole:    params[5],
        baseAmt:      params[6],
        dcAmt:        params[7],
        cancelBtn:    params[8],
        selfTYn:      params[9],
        macroChk:     params[10],
      });
    }
  }

  if (slots.length === 0) {
    throw new Error(`${booking.date} 예약 가능한 타임이 없습니다`);
  }

  // Filter by time range if specified (timeFrom/timeTo in "HH:MM" format)
  let eligibleSlots = slots.slice();
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
      'User-Agent': UA,
      'Accept': '*/*',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'sec-ch-ua': CH_UA,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'Referer': `${BASE}/reservation/golf`,
    },
    body: new URLSearchParams({
      bookgDate: dateKey,
      bookgTime: best.bookgTime,
      bookgCourse: best.bookgCourse,
      bookgCourseNm: best.bookgCourseNm,
      bookgTimeDisp: best.bookgTimeDisp,
      bookgHole: best.bookgHole,
      baseAmt: best.baseAmt,
      dcAmt: best.dcAmt,
      cancelBtn: best.cancelBtn,
      selfTYn: best.selfTYn,
      macroChk: best.macroChk,
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
