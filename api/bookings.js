const { kv } = require('@vercel/kv');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const bookings = await kv.get('bookings') || [];
    return res.json(bookings);
  }

  if (req.method === 'POST') {
    const { club, course, date, time, timeFrom, timeTo, openDate, openTime, memo } = req.body;
    if (!club || !date || !time || !openDate) {
      return res.status(400).json({ error: '필수 항목 누락' });
    }
    const bookings = await kv.get('bookings') || [];
    const booking = {
      id: Date.now(),
      club, course, date, time,
      timeFrom: timeFrom || '',
      timeTo: timeTo || '',
      openDate, openTime: openTime || '10:00',
      memo: memo || '',
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    bookings.push(booking);
    await kv.set('bookings', bookings);
    return res.status(201).json(booking);
  }

  if (req.method === 'PATCH') {
    const { id, status } = req.body;
    const allowed = ['pending', 'cancelled'];
    if (!id || !allowed.includes(status)) {
      return res.status(400).json({ error: '잘못된 요청' });
    }
    const bookings = await kv.get('bookings') || [];
    const idx = bookings.findIndex(b => b.id === Number(id));
    if (idx === -1) return res.status(404).json({ error: '예약 없음' });
    bookings[idx].status = status;
    bookings[idx].cancelledAt = status === 'cancelled' ? new Date().toISOString() : undefined;
    await kv.set('bookings', bookings);
    return res.json(bookings[idx]);
  }

  if (req.method === 'DELETE') {
    const { id } = req.query;
    const bookings = await kv.get('bookings') || [];
    const updated = bookings.filter(b => b.id !== Number(id));
    await kv.set('bookings', updated);
    return res.json({ ok: true });
  }

  res.status(405).end();
};
