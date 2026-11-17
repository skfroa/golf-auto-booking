const { kv } = require('@vercel/kv');
const { bookLakewood } = require('../lib/lakewood');

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

  console.log(`[Cron] Running for date: ${todayStr}`);

  const [bookings, clubs] = await Promise.all([
    kv.get('bookings').then(v => v || []),
    kv.get('clubs').then(v => v || {}),
  ]);

  const toRun = bookings.filter(b => b.status === 'pending' && b.openDate === todayStr);
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
        result = await bookLakewood(cred, booking);
      } else if (booking.club === 'eh') {
        // 은화삼 추가 예정
        throw new Error('은화삼CC 미구현');
      } else {
        throw new Error('알 수 없는 골프장');
      }

      await updateStatus(bookings, booking.id, 'done', null, result.time, result.course);
      results.push({ id: booking.id, status: 'done', time: result.time });
      console.log(`[Cron] ✅ ${booking.club} ${booking.date} ${result.time} 예약 완료`);
    } catch (err) {
      console.error(`[Cron] ❌ ${booking.club} ${booking.date} 실패:`, err.message);
      await updateStatus(bookings, booking.id, 'fail', err.message);
      results.push({ id: booking.id, status: 'fail', reason: err.message });
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
