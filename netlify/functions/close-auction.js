// netlify/functions/close-auction.js
// Called when admin closes an auction item.
// Finds the highest bidder, marks them as pending winner,
// sends winner confirmation request + admin notifications.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let payload;
  try { payload = JSON.parse(event.body); } catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  const { item_id } = payload;
  if (!item_id) return { statusCode: 400, body: 'item_id required' };

  const SUPABASE_URL   = process.env.SUPABASE_URL;
  const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  console.log('Using key type:', process.env.SUPABASE_SERVICE_KEY ? 'service_role' : 'anon');
  console.log('Item ID received:', item_id);
  const RESEND_KEY     = process.env.RESEND_API_KEY;
  const TWILIO_SID     = process.env.TWILIO_ACCOUNT_SID;
  const TWILIO_TOKEN   = process.env.TWILIO_AUTH_TOKEN;
  const TWILIO_FROM    = process.env.TWILIO_FROM_NUMBER;
  const FROM_EMAIL     = 'fishing@tamparoughriders.org';
  const AUCTION_URL    = 'https://roughriders-auction.netlify.app';
  const CONFIRM_HOURS  = 48;

  const results = [];

  async function sbFetch(path, opts = {}) {
    const method = opts.method || 'GET';
    const headers = {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...opts.headers
    };
    // Only set Prefer header for writes
    if (method !== 'GET') {
      headers['Prefer'] = opts.prefer || 'return=minimal';
    }
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers,
      method,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    console.log(`sbFetch ${method} ${path} -> ${res.status}`);
    const text = await res.text();
    if (!res.ok) console.error('sbFetch error body:', text.substring(0, 300));
    return text ? JSON.parse(text) : null;
  }

  async function sendEmail(to, subject, html) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `Rough Riders Auction <${FROM_EMAIL}>`, to: [to], subject, html })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Resend: ${JSON.stringify(data)}`);
    return data;
  }

  async function sendSMS(to, body) {
    let phone = to.replace(/\D/g, '');
    if (phone.length === 10) phone = '+1' + phone;
    else if (!phone.startsWith('+')) phone = '+' + phone;
    const params = new URLSearchParams({ To: phone, From: TWILIO_FROM, Body: body });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Twilio: ${JSON.stringify(data)}`);
    return data;
  }

  async function notify(channel, email, phone, subject, html, sms) {
    const sends = [];
    if ((channel === 'email' || channel === 'both') && email) sends.push(sendEmail(email, subject, html).catch(e => `email-err:${e.message}`));
    if ((channel === 'text' || channel === 'both') && phone) sends.push(sendSMS(phone, sms).catch(e => `sms-err:${e.message}`));
    return Promise.all(sends);
  }

  // ── 1. Get item details ──
  const items = await sbFetch(`auction_items?id=eq.${item_id}&select=*`);
  const item = items?.[0];
  console.log('Items found:', items?.length, 'First:', item?.id);
  if (!item) return { statusCode: 404, body: JSON.stringify({ ok: false, msg: `Item not found. ID: ${item_id}. Items returned: ${JSON.stringify(items)}` }) };

  // ── 2. Get highest bidder ──
  const bids = await sbFetch(`auction_bids?item_id=eq.${item_id}&order=amount.desc&limit=1&select=*`);
  const winnerBid = bids?.[0];
  if (!winnerBid) {
    // No bids — just close it
    await sbFetch(`auction_items?id=eq.${item_id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { status: 'closed', winner_status: 'no_bids' }
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true, winner: null, msg: 'Closed with no bids' }) };
  }

  // ── 3. Generate confirmation token ──
  const token = Buffer.from(`${item_id}:${winnerBid.bidder_email}:${Date.now()}`).toString('base64url');
  // Use item's actual ends_at if it exists and is in the future, otherwise 48hr from now
  const itemEndsAt = item.ends_at ? new Date(item.ends_at) : null;
  const confirmDeadline = (itemEndsAt && itemEndsAt > new Date())
    ? itemEndsAt.toISOString()
    : new Date(Date.now() + CONFIRM_HOURS * 3600000).toISOString();
  const confirmUrl = `${AUCTION_URL}/?confirm=${token}`;
  const declineUrl = `${AUCTION_URL}/?decline=${token}`;

  // ── 4. Save winner info on item ──
  await sbFetch(`auction_items?id=eq.${item_id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: {
      status: 'closed',
      winner_status: 'pending',
      winner_name: winnerBid.bidder_name,
      winner_email: winnerBid.bidder_email,
      winner_phone: winnerBid.bidder_phone,
      winner_bid: winnerBid.amount,
      winner_token: token,
      winner_deadline: confirmDeadline
    }
  });

  const deadlineStr = new Date(confirmDeadline).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
  });

  // ── 5. EMAIL: Winner notification ──
  const winnerEmailHtml = `
<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f9fafb;margin:0;padding:0">
<div style="max-width:580px;margin:32px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08)">
  <div style="background:#1e3a5f;padding:28px 24px;text-align:center">
    <p style="color:rgba(255,255,255,0.6);font-size:11px;letter-spacing:3px;text-transform:uppercase;margin:0 0 8px">Rough Riders Fishing Tournament</p>
    <h1 style="color:#ffffff;font-size:26px;margin:0;font-weight:700">🏆 You Won!</h1>
  </div>
  <div style="padding:32px 28px">
    <h2 style="color:#111827;font-size:20px;margin:0 0 8px">Congratulations, ${winnerBid.bidder_name.split(' ')[0]}!</h2>
    <p style="color:#6b7280;font-size:15px;line-height:1.6;margin-bottom:20px">
      Your bid of <strong style="color:#1e3a5f;font-size:18px">$${winnerBid.amount.toLocaleString()}</strong> is the winning bid on:
    </p>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-left:4px solid #1e3a5f;border-radius:8px;padding:16px 20px;margin-bottom:24px">
      <p style="font-size:18px;font-weight:700;color:#111827;margin:0 0 6px">${item.title}</p>
      ${item.description ? `<p style="font-size:14px;color:#6b7280;margin:0">${item.description.substring(0, 120)}${item.description.length > 120 ? '…' : ''}</p>` : ''}
    </div>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin-bottom:24px">
      Please <strong>confirm your win by ${deadlineStr}</strong>. If we don't hear back, the item will be offered to the next highest bidder.
    </p>
    <div style="display:flex;gap:12px;margin-bottom:28px;flex-wrap:wrap">
      <a href="${confirmUrl}" style="flex:1;min-width:140px;display:block;text-align:center;background:#16a34a;color:#ffffff;font-weight:700;font-size:15px;padding:14px 20px;border-radius:8px;text-decoration:none">
        ✅ Yes, I'll Take It!
      </a>
      <a href="${declineUrl}" style="flex:1;min-width:140px;display:block;text-align:center;background:#f9fafb;color:#6b7280;font-weight:600;font-size:15px;padding:14px 20px;border-radius:8px;text-decoration:none;border:1px solid #e5e7eb">
        Decline
      </a>
    </div>
    <p style="color:#9ca3af;font-size:13px;line-height:1.5">
      Payment arrangements will be made at or before the tournament. Questions? Reply to this email or contact 
      <a href="mailto:fishing@tamparoughriders.org" style="color:#1e3a5f">fishing@tamparoughriders.org</a>
    </p>
  </div>
  <div style="background:#f9fafb;padding:16px 24px;text-align:center;border-top:1px solid #e5e7eb">
    <p style="color:#9ca3af;font-size:12px;margin:0">1st U.S. Volunteer Cavalry Regiment – Rough Riders, Inc. • Tampa, FL</p>
  </div>
</div>
</body></html>`;

  const winnerSms = `🏆 Congrats ${winnerBid.bidder_name.split(' ')[0]}! You won "${item.title}" with a bid of $${winnerBid.amount}. Please confirm: ${confirmUrl}  (48hr deadline)`;

  try {
    const channel = winnerBid.contact_method || 'email';
    const r = await notify(channel, winnerBid.bidder_email, winnerBid.bidder_phone, `🏆 You won: "${item.title}"`, winnerEmailHtml, winnerSms);
    results.push({ type: 'winner', to: winnerBid.bidder_email, result: r });
  } catch(e) {
    results.push({ type: 'winner', error: e.message });
  }

  // ── 6. NOTIFY ADMINS ──
  try {
    const settingsRes = await sbFetch(`auction_settings?key=eq.admin_notif_recipients&select=value`);
    const adminRecipients = settingsRes?.[0]?.value ? JSON.parse(settingsRes[0].value) : [];

    const adminEmailHtml = `
<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f9fafb;margin:0;padding:0">
<div style="max-width:580px;margin:32px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08)">
  <div style="background:#1e3a5f;padding:24px;text-align:center">
    <p style="color:rgba(255,255,255,0.6);font-size:11px;letter-spacing:3px;text-transform:uppercase;margin:0 0 6px">Rough Riders Auction — Admin</p>
    <h1 style="color:#ffffff;font-size:22px;margin:0;font-weight:700">Auction Item Closed</h1>
  </div>
  <div style="padding:28px">
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
      <tr style="background:#f9fafb"><td style="padding:10px 12px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #e5e7eb;width:35%">Item</td><td style="padding:10px 12px;font-size:14px;color:#111827;border-bottom:1px solid #e5e7eb"><strong>${item.title}</strong></td></tr>
      <tr><td style="padding:10px 12px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #e5e7eb">Winner</td><td style="padding:10px 12px;font-size:14px;color:#111827;border-bottom:1px solid #e5e7eb">${winnerBid.bidder_name}</td></tr>
      <tr style="background:#f9fafb"><td style="padding:10px 12px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #e5e7eb">Email</td><td style="padding:10px 12px;font-size:14px;color:#111827;border-bottom:1px solid #e5e7eb">${winnerBid.bidder_email}</td></tr>
      <tr><td style="padding:10px 12px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #e5e7eb">Phone</td><td style="padding:10px 12px;font-size:14px;color:#111827;border-bottom:1px solid #e5e7eb">${winnerBid.bidder_phone || '—'}</td></tr>
      <tr style="background:#f9fafb"><td style="padding:10px 12px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:1px">Winning Bid</td><td style="padding:10px 12px;font-size:20px;font-weight:800;color:#1e3a5f"><strong>$${winnerBid.amount.toLocaleString()}</strong></td></tr>
    </table>
    <p style="color:#6b7280;font-size:14px;line-height:1.6">
      Winner confirmation email sent. They have until <strong>${deadlineStr}</strong> to confirm.
      Status will update automatically in the admin panel.
    </p>
    <div style="text-align:center;margin-top:20px">
      <a href="${AUCTION_URL}" style="background:#1e3a5f;color:#ffffff;font-weight:600;font-size:14px;padding:12px 28px;border-radius:8px;text-decoration:none;display:inline-block">View Auction Admin</a>
    </div>
  </div>
</div>
</body></html>`;

    const adminSms = `RR Auction closed: "${item.title}" — Winner: ${winnerBid.bidder_name} ($${winnerBid.amount}). Confirmation sent, deadline: ${deadlineStr}.`;

    for (const admin of adminRecipients) {
      const channel = admin.viaEmail && admin.viaText ? 'both' : admin.viaText ? 'text' : 'email';
      try {
        const r = await notify(channel, admin.email, admin.phone, `Auction closed: "${item.title}"`, adminEmailHtml, adminSms);
        results.push({ type: 'admin', to: admin.name, result: r });
      } catch(e) {
        results.push({ type: 'admin', to: admin.name, error: e.message });
      }
    }
  } catch(e) {
    results.push({ type: 'admin-notify', error: e.message });
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, winner: winnerBid.bidder_name, amount: winnerBid.amount, results })
  };
};
