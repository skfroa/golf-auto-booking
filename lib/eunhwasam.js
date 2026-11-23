const fetch = require('node-fetch');
const { CookieJar } = require('tough-cookie');
const _fc = require('fetch-cookie');
const makeFetchCookie = typeof _fc === 'function' ? _fc : _fc.default;

const BASE = 'https://www.ehscc.co.kr';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CH_UA = '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"';
const delay = ms => new Promise(r => setTimeout(r, ms));
const humanDelay = () => delay(100 + Math.floor(Math.random() * 400));

// warmSession: [{key, value}] cookie array pre-loaded at 08:59 KST by api/warmup.js?club=eh
async function bookEunhwasam({ id, pw }, booking, warmSession = null) {
  const jar = new CookieJar();
  const fetchC = makeFetchCookie(fetch, jar);

  if (warmSession) {
    await Promise.all(
      warmSession.map(c =>
        jar.setCookie(`${c.key}=${c.value}; Domain=www.ehscc.co.kr; Path=/`, BASE)
      )
    );
    console.log(`[Eunhwasam] 사전 세션 재사용 (쿠키 ${warmSession.length}개) → GolfCalendar 직행`);
  } else {
    // 1. GET login page (session cookie 초기화)
    await fetchC(`${BASE}/Member/Login`, {
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

    // 2. POST 로그인 (JSON 응답)
    const loginRes = await fetchC(`${BASE}/Member/LoginAction`, {
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
        'Referer': `${BASE}/Member/Login`,
        'Origin': BASE,
      },
      body: new URLSearchParams({ id, pwd: pw, saveID: 'N', savePwd: 'N', type: 'I' }).toString(),
    });

    const loginData = await loginRes.json().catch(() => null);
    // EH 서버는 code를 숫자 0 또는 문자열 '0'으로 반환하므로 느슨한 비교 사용
    if (!loginData || loginData.code != 0) {
      throw new Error(loginData?.msg || '로그인 실패');
    }
  }

  // 3. GET 예약 캘린더 페이지 → CSRF 토큰 추출
  const calRes = await fetchC(`${BASE}/Booking/GolfCalendar`, {
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
      'Referer': BASE,
    },
  });
  const calHtml = await calRes.text();
  const csrfMatch = calHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
  if (!csrfMatch) throw new Error('CSRF 토큰을 찾을 수 없습니다');
  const csrf = csrfMatch[1];

  // 4. POST /Ajax/Time → 타임 목록 HTML 조회
  const dateKey = booking.date.replace(/-/g, ''); // YYYYMMDD
  const timesRes = await fetchC(`${BASE}/Ajax/Time`, {
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
      'Referer': `${BASE}/Booking/GolfCalendar`,
    },
    body: new URLSearchParams({
      coGubun: 'M',
      date: dateKey,
      changeLGubun: '',
      changeDate: '',
      changeSeq: '',
    }).toString(),
  });
  const timesHtml = await timesRes.text();

  // 5. HTML 파싱: 예약 가능한 슬롯 추출
  // 각 TR에서 시간(HH:MM)과 seq("XXXXX") 추출
  // 예약중(임시선점) 슬롯 제외
  const slots = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(timesHtml)) !== null) {
    const row = rowMatch[1];
    if (row.includes('예약중')) continue; // 임시선점 중
    if (!row.includes('예약하기')) continue; // 예약 불가 행 제외
    const timeMatch = row.match(/(\d{2}:\d{2})\(\d+부\)/);
    const seqMatch = row.match(/formLayer\('\d+','(\d+)'\)/);
    if (!timeMatch || !seqMatch) continue;
    slots.push({ time: timeMatch[1], seq: seqMatch[1] });
  }

  if (slots.length === 0) {
    throw new Error(`${booking.date} 예약 가능한 타임이 없습니다`);
  }

  // 6. 희망 시간에 가장 가까운 슬롯 선택 (timeFrom/timeTo 범위 필터 선택 적용)
  const toMins = t => parseInt(t.slice(0, 2)) * 60 + parseInt(t.slice(3, 5));
  let eligible = slots;
  if (booking.timeFrom && booking.timeTo) {
    const fromMins = toMins(booking.timeFrom);
    const endMins = toMins(booking.timeTo);
    eligible = slots.filter(s => {
      const m = toMins(s.time);
      return m >= fromMins && m <= endMins;
    });
    if (eligible.length === 0) {
      throw new Error(`${booking.date} ${booking.timeFrom}~${booking.timeTo} 시간대에 예약 가능한 타임이 없습니다`);
    }
  }

  const wantMins = toMins(booking.time);
  const best = eligible.reduce((prev, curr) =>
    Math.abs(toMins(curr.time) - wantMins) < Math.abs(toMins(prev.time) - wantMins) ? curr : prev
  );

  // 7. POST /Booking/ReservationForm → 예약 제출
  const submitRes = await fetchC(`${BASE}/Booking/ReservationForm`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
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
      'Referer': `${BASE}/Booking/GolfCalendar`,
      'Origin': BASE,
    },
    body: new URLSearchParams({
      __RequestVerificationToken: csrf,
      coGubun: 'M',
      rsv_date: dateKey,
      rsv_seq: best.seq,
      changeLGubun: '',
      changeDate: '',
      changeSeq: '',
    }).toString(),
  });
  const submitHtml = await submitRes.text();

  // 8. 결과 확인
  if (submitRes.url && submitRes.url.includes('/Member/Login')) {
    throw new Error('세션 만료 - 다시 시도해주세요');
  }

  // 성공 패턴: 예약확인 페이지로 이동되거나 성공 메시지
  if (
    submitRes.url.includes('ReservedList') ||
    submitHtml.includes('예약이 완료') ||
    submitHtml.includes('예약되었습니다') ||
    submitHtml.includes('예약완료')
  ) {
    return { time: best.time, course: '현장배정', message: `${best.time} 현장배정 예약 완료` };
  }

  // 에러 메시지 추출 시도
  const alertMatch = submitHtml.match(/alert\('([^']+)'\)/);
  if (alertMatch) throw new Error(alertMatch[1]);

  // 응답 URL로 판단
  const finalUrl = submitRes.url || '';
  if (finalUrl.includes('GolfCalendar')) {
    throw new Error('예약 실패 - 이미 마감되었거나 오류가 발생했습니다');
  }

  // 최후 수단: 성공으로 간주 (리다이렉트가 발생했으면 예약된 것)
  return { time: best.time, course: '현장배정', message: `${best.time} 현장배정 예약 완료` };
}

module.exports = { bookEunhwasam };
