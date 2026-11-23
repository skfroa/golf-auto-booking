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

  // retrying: 오픈 직후 10분 창 내 재시도 중인 예약
  // waitlist: 10분 창 이후 취소 슬롯을 기다리는 예약
  const toProcess = bookings.filter(b => b.status === 'retrying' || b.status === 'waitlist');
  if (!toProcess.length) {
    return res.json({ checked: 0, message: '처리할 예약 없음', timestamp: now.toISOString() });
  }

  console.log(`[Waitlist] ${toProcess.length}건 체크 시작`);
  const results = [];

  for (const booking of toProcess) {
    const idx = bookings.findIndex(b => b.id === booking.id);
    if (idx === -1) continue;

    // ── retrying: 오픈 후 10분 창 내 재시도 ──
    if (booking.status === 'retrying') {
      const retryUntil = booking.retryUntil ? new Date(booking.retryUntil) : null;

      if (!retryUntil || now >= retryUntil) {
        // 10분 창 종료 → enableWaitlist이면 대기예약으로, 아니면 최종 실패
        if (booking.enableWaitlist) {
          bookings[idx].status = 'waitlist';
          bookings[idx].waitlistStartedAt = now.toISOString();
          delete bookings[idx].retryUntil;
          results.push({ id: booking.id, status: 'waitlist→continued', reason: '10분 창 종료, 대기예약으로 전환' });
          console.log(`[Waitlist] 🔄 ${booking.club} ${booking.date} → 대기예약으로 전환 (10분 창 종료)`);
        } else {
          bookings[idx].status = 'fail';
          bookings[idx].errMsg = `10분 재시도 후 최종 실패: ${booking.lastErrMsg || ''}`;
          bookings[idx].executedAt = now.toISOString();
          results.push({ id: booking.id, status: 'fail', reason: 'retrying 창 만료' });
          console.log(`[Waitlist] ❌ ${booking.club} ${booking.date} → 최종 실패 (10분 창 종료)`);
        }
        continue;
      }

      const cred = clubs[booking.club];
      if (!cred?.id || !cred?.pw) {
        results.push({ id: booking.id, status: 'skip', reason: 'ID/PW 미설정' });
        continue;
      }

      bookings[idx].lastCheckedAt = now.toISOString();
      bookings[idx].retryCount = (bookings[idx].retryCount || 0) + 1;

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
        delete bookings[idx].retryUntil;

        results.push({ id: booking.id, status: 'done', time: result.time });
        console.log(`[Waitlist] ✅ ${booking.club} ${booking.date} ${result.time} 재시도 성공!`);
      } catch (err) {
        bookings[idx].lastErrMsg = err.message;
        results.push({ id: booking.id, status: 'retrying', reason: err.message });
        console.log(`[Waitlist] ↩️ ${booking.club} ${booking.date} 재시도 실패 (${bookings[idx].retryCount}회): ${err.message}`);
      }
      continue;
    }

    // ── waitlist: 취소 슬롯 대기 (기존 로직) ──
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
