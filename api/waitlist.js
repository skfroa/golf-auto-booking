const { kv } = require('@vercel/kv');
const { bookLakewood } = require('../lib/lakewood');
const { bookEunhwasam } = require('../lib/eunhwasam');

// Called by Upstash QStash every 10 minutes
// URL: /api/waitlist?secret=<CRON_SECRET>
module.exports = async function handler(req, res) {
  const authorized =
    req.headers.authorization === `Bearer ${process.env.CRON_SECRET}` ||
    req.query.secret === process.env.CRON_SECRET;
  if (!authorized) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 60 * 60000);
  const today = kstNow.toISOString().slice(0, 10);

  console.log(`[Waitlist] Check at ${now.toISOString()} (KST: ${today})`);

  const [bookings, clubs] = await Promise.all([
    kv.get('bookings').then(v => v || []),
    kv.get('clubs').then(v => v || {}),
  ]);

  const waitlisted = bookings.filter(b => b.status === 'waitlist');
  if (!waitlisted.length) {
    return res.json({ checked: 0, message: '대기 예약 없음', timestamp: now.toISOString() });
  }

  console.log(`[Waitlist] ${waitlisted.length}건 체크 시작`);
  const results = [];

  for (const booking of waitlisted) {
    const idx = bookings.findIndex(b => b.id === booking.id);
    if (idx === -1) continue;

    // Expire if round date has passed or waitlistUntil reached
    const expiry = booking.waitlistUntil || booking.date;
    if (expiry < today) {
      bookings[idx].status = 'fail';
      bookings[idx].errMsg = `대기 예약 종료 (${expiry} 초과)`;
      results.push({ id: booking.id, status: 'expired', date: booking.date });
      console.log(`[Waitlist] ⏰ ${booking.id} 만료`);
      continue;
    }

    const cred = clubs[booking.club];
    if (!cred?.id || !cred?.pw) {
      results.push({ id: booking.id, status: 'skip', reason: 'ID/PW 미설정' });
      continue;
    }

    // Update check metadata
    bookings[idx].lastCheckedAt = now.toISOString();
    bookings[idx].checkCount = (bookings[idx].checkCount || 0) + 1;

    try {
      let result;
      if (booking.club === 'lk') {
        result = await bookLakewood(cred, booking);
      } else if (booking.club === 'eh') {
        result = await bookEunhwasam(cred, booking);
      } else {
        throw new Error('알 수 없는 골프장');
      }

      bookings[idx].status = 'done';
      bookings[idx].bookedTime = result.time;
      bookings[idx].bookedCourse = result.course;
      bookings[idx].bookedAt = now.toISOString();
      delete bookings[idx].lastErrMsg;

      results.push({ id: booking.id, status: 'done', time: result.time });
      console.log(`[Waitlist] ✅ ${booking.club} ${booking.date} ${result.time} 취소 타임 예약 완료!`);
    } catch (err) {
      // No slot yet — keep as waitlist, record last error
      bookings[idx].lastErrMsg = err.message;
      results.push({ id: booking.id, status: 'waitlist', reason: err.message });
      console.log(`[Waitlist] ⏳ ${booking.club} ${booking.date} 대기 중: ${err.message}`);
    }
  }

  await kv.set('bookings', bookings);
  return res.json({
    checked: waitlisted.length,
    results,
    timestamp: now.toISOString(),
  });
};
