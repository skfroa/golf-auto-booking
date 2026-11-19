const { kv } = require('@vercel/kv');
const { bookLakewood } = require('../lib/lakewood');
const { bookEunhwasam } = require('../lib/eunhwasam');

// Runs every day at 10:00 AM KST (01:00 UTC)
// vercel.json: "schedule": "0 1 * * *"
module.exports = async function handler(req, res) {
  // Vercel Cron auth
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const today = new Date();
  // KST = UTC+9: check today's date in KST
  const kstOffset = 9 * 60;
  const kstNow = new Date(today.getTime() + kstOffset * 60000);
  const todayStr = kstNow.toISOString().slice(0, 10); // YYYY-MM-DD
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
    toMins(b.openTime) <= currentKSTMins
  );
  console.log(`[Cron] Found ${toRun.length} booking(s) to execute`);

  const results = [];

  for (const booking of toRun) {
    const cred = clubs[booking.club];
    if (!cred || !cred.id || !cred.pw) {
      await updateStatus(bookings, booking.id, 'fail', 'ID/PW 미설정');
      results.push({ id: booking.id, status: 'fail', reason: 'no credentials' });
      continue;
    }

    try {
      let result;
      if (booking.club === 'lk') {
        let warmSession = null;
        try {
          const stored = await kv.get('warmup:lk');
          if (stored) {
            warmSession = JSON.parse(stored);
            await kv.del('warmup:lk');
            console.log(`[Cron] 레이크우드 웜업 세션 적용 (쿠키 ${warmSession.length}개)`);
          }
        } catch (e) {
          console.warn('[Cron] 웜업 세션 로드 실패, 일반 플로우로 진행:', e.message);
        }
        result = await bookLakewood(cred, booking, warmSession);
      } else if (booking.club === 'eh') {
        let warmSessionEh = null;
        try {
          const stored = await kv.get('warmup:eh');
          if (stored) {
            warmSessionEh = JSON.parse(stored);
            await kv.del('warmup:eh');
            console.log(`[Cron] 은화삼 웜업 세션 적용 (쿠키 ${warmSessionEh.length}개)`);
          }
        } catch (e) {
          console.warn('[Cron] 은화삼 웜업 세션 로드 실패, 일반 플로우로 진행:', e.message);
        }
        result = await bookEunhwasam(cred, booking, warmSessionEh);
      } else {
        throw new Error('알 수 없는 골프장');
      }

      await updateStatus(bookings, booking.id, 'done', null, result.time, result.course);
      results.push({ id: booking.id, status: 'done', time: result.time });
      console.log(`[Cron] ✅ ${booking.club} ${booking.date} ${result.time} 예약 완료`);
    } catch (err) {
      console.error(`[Cron] ❌ ${booking.club} ${booking.date} 실패:`, err.message);
      // enableWaitlist=true 이면 실패 대신 대기예약으로 전환
      if (booking.enableWaitlist) {
        const idx = bookings.findIndex(b => b.id === booking.id);
        if (idx !== -1) {
          bookings[idx].status = 'waitlist';
          bookings[idx].lastErrMsg = err.message;
          bookings[idx].waitlistStartedAt = new Date().toISOString();
        }
        results.push({ id: booking.id, status: 'waitlist', reason: err.message });
        console.log(`[Cron] 🔄 ${booking.club} ${booking.date} → 대기예약으로 전환`);
      } else {
        await updateStatus(bookings, booking.id, 'fail', err.message);
        results.push({ id: booking.id, status: 'fail', reason: err.message });
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
