const { kv } = require('@vercel/kv');
const { bookLakewood } = require('../lib/lakewood');
const { bookEunhwasam } = require('../lib/eunhwasam');

// Runs at 08:59 KST (23:59 UTC) and 09:59 KST (00:59 UTC) — 1 min before opening
// Waits until exact openTime, then retries every 15s for up to 4 min within function.
// If still failing after 4 min but within 10-min window → 'retrying' (waitlist cron picks up)
// maxDuration: 300 (vercel.json)
const RETRY_INTERVAL_MS = 15 * 1000;
const RETRY_WINDOW_MS = 10 * 60 * 1000;    // 10분 재시도 창
const IN_FUNC_LIMIT_MS = 4 * 60 * 1000;    // 함수 내 최대 4분 재시도

module.exports = async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const today = new Date();
  const kstOffset = 9 * 60;
  const kstNow = new Date(today.getTime() + kstOffset * 60000);
  const todayStr = kstNow.toISOString().slice(0, 10);
  const currentKSTMins = kstNow.getUTCHours() * 60 + kstNow.getUTCMinutes();
  const toMins = t => t ? parseInt(t.slice(0, 2)) * 60 + parseInt(t.slice(3, 5)) : 600;

  console.log(`[Cron] Running for date: ${todayStr}, KST time: ${String(kstNow.getUTCHours()).padStart(2,'0')}:${String(kstNow.getUTCMinutes()).padStart(2,'0')}`);

  const [bookings, clubs] = await Promise.all([
    kv.get('bookings').then(v => v || []),
    kv.get('clubs').then(v => v || {}),
  ]);

  const toRun = bookings.filter(b =>
    b.status === 'pending' &&
    b.openDate === todayStr &&
    toMins(b.openTime) <= currentKSTMins + 2
  );
  console.log(`[Cron] Found ${toRun.length} booking(s) to execute`);

  const results = [];

  for (const booking of toRun) {
    const cred = clubs[booking.club];
    if (!cred || !cred.id || !cred.pw) {
      updateStatus(bookings, booking.id, 'fail', 'ID/PW 미설정');
      results.push({ id: booking.id, status: 'fail', reason: 'no credentials' });
      continue;
    }

    // 오픈 시각까지 정밀 대기 (최대 65초)
    const nowForWait = new Date();
    const kstForWait = new Date(nowForWait.getTime() + 9 * 3600000);
    const kstTotalSec = kstForWait.getUTCHours() * 3600 + kstForWait.getUTCMinutes() * 60 + kstForWait.getUTCSeconds();
    const openTotalSec = toMins(booking.openTime) * 60;
    const msUntilOpen = (openTotalSec - kstTotalSec) * 1000;
    if (msUntilOpen > 0 && msUntilOpen < 65000) {
      console.log(`[Cron] ⏱ ${booking.openTime} 오픈까지 ${msUntilOpen}ms 대기`);
      await new Promise(r => setTimeout(r, msUntilOpen));
    }

    // 웜업 세션 로드 (첫 번째 시도에만 사용)
    let warmSession = null;
    if (booking.club === 'lk') {
      try {
        const stored = await kv.get('warmup:lk');
        if (stored) {
          warmSession = JSON.parse(stored);
          console.log(`[Cron] 레이크우드 웜업 세션 적용 (쿠키 ${warmSession.length}개)`);
        }
      } catch (e) {
        console.warn('[Cron] 웜업 세션 로드 실패:', e.message);
      }
    } else if (booking.club === 'eh') {
      try {
        const stored = await kv.get('warmup:eh');
        if (stored) {
          warmSession = JSON.parse(stored);
          console.log(`[Cron] 은화삼 웜업 세션 적용 (쿠키 ${warmSession.length}개)`);
        }
      } catch (e) {
        console.warn('[Cron] 은화삼 웜업 세션 로드 실패:', e.message);
      }
    }

    // 10분 재시도 루프 (오픈 직후부터 시작)
    const retryUntilMs = Date.now() + RETRY_WINDOW_MS;
    const maxInFunctionEndMs = Date.now() + IN_FUNC_LIMIT_MS;
    let lastErr = null;
    let result = null;
    let attempt = 0;

    while (true) {
      attempt++;
      try {
        if (booking.club === 'lk') {
          result = await bookLakewood(cred, booking, attempt === 1 ? warmSession : null);
        } else if (booking.club === 'eh') {
          result = await bookEunhwasam(cred, booking, attempt === 1 ? warmSession : null);
        } else {
          throw new Error('알 수 없는 골프장');
        }
        break; // 성공
      } catch (err) {
        lastErr = err;
        const now = Date.now();
        console.error(`[Cron] ↩️ ${booking.club} ${booking.date} 시도 ${attempt} 실패: ${err.message}`);

        if (now >= retryUntilMs) {
          // 10분 창 초과 → 종료
          break;
        }
        if (now >= maxInFunctionEndMs) {
          // 함수 시간 초과 → waitlist cron에 위임
          break;
        }

        // 다음 재시도까지 대기 (남은 시간 초과하지 않도록)
        const remaining = Math.min(retryUntilMs, maxInFunctionEndMs) - now;
        const waitMs = Math.min(RETRY_INTERVAL_MS, remaining - 1000);
        if (waitMs > 500) {
          console.log(`[Cron] ⏳ ${waitMs / 1000}초 후 재시도 (시도 ${attempt + 1}번째)...`);
          await new Promise(r => setTimeout(r, waitMs));
        } else {
          break;
        }
      }
    }

    const idx = bookings.findIndex(b => b.id === booking.id);
    if (result) {
      updateStatus(bookings, booking.id, 'done', null, result.time, result.course);
      results.push({ id: booking.id, status: 'done', time: result.time, attempt });
      console.log(`[Cron] ✅ ${booking.club} ${booking.date} ${result.time} 완료 (${attempt}번째 시도)`);
    } else {
      const now = Date.now();
      if (now < retryUntilMs && idx !== -1) {
        // 아직 10분 창 내 → retrying 상태로 전환 (waitlist cron이 계속 시도)
        bookings[idx] = {
          ...bookings[idx],
          status: 'retrying',
          retryUntil: new Date(retryUntilMs).toISOString(),
          lastErrMsg: lastErr?.message,
          executedAt: new Date().toISOString(),
          retryCount: attempt,
        };
        results.push({ id: booking.id, status: 'retrying', attempt, reason: lastErr?.message });
        console.log(`[Cron] 🔄 ${booking.club} ${booking.date} → retrying (${attempt}회 실패, 창 남음 → waitlist cron 위임)`);
      } else {
        // 10분 창 종료
        if (booking.enableWaitlist && idx !== -1) {
          bookings[idx] = {
            ...bookings[idx],
            status: 'waitlist',
            lastErrMsg: lastErr?.message,
            waitlistStartedAt: new Date().toISOString(),
            retryCount: attempt,
            executedAt: new Date().toISOString(),
          };
          results.push({ id: booking.id, status: 'waitlist', attempt, reason: lastErr?.message });
          console.log(`[Cron] 🔄 ${booking.club} ${booking.date} → 대기예약 (${attempt}회 실패)`);
        } else {
          if (idx !== -1) {
            bookings[idx] = {
              ...bookings[idx],
              status: 'fail',
              errMsg: lastErr?.message,
              executedAt: new Date().toISOString(),
              retryCount: attempt,
            };
          }
          results.push({ id: booking.id, status: 'fail', attempt, reason: lastErr?.message });
          console.log(`[Cron] ❌ ${booking.club} ${booking.date} 최종 실패 (${attempt}회 시도)`);
        }
      }
    }
  }

  await kv.set('bookings', bookings);
  res.json({ date: todayStr, executed: toRun.length, results });
};

function updateStatus(bookings, id, status, errMsg, bookedTime, bookedCourse) {
  const idx = bookings.findIndex(b => b.id === id);
  if (idx === -1) return;
  bookings[idx] = {
    ...bookings[idx],
    status,
    executedAt: new Date().toISOString(),
    ...(errMsg ? { errMsg } : {}),
    ...(bookedTime ? { bookedTime } : {}),
    ...(bookedCourse ? { bookedCourse } : {}),
  };
}
