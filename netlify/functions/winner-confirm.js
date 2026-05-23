// netlify/functions/winner-confirm.js
// Called when winner clicks Confirm or Decline link.
// Updates winner_status on the item and notifies admins.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let payload;
  try { payload = JSON.parse(event.body); } catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  const { token, action } = payload; // action: 'confirm' or 'decline'
  if (!token || !['confirm','decline'].includes(action)) return { statusCode: 400, body: 'Invalid payload' };

  const SUPABASE_URL  = process.env.SUPABASE_URL;
  const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
  const RESEND_KEY    = process.env.RESEND_API_KEY;
  const TWILIO_SID    = process.env.TWILIO_ACCOUNT_SID;
  const TWILIO_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
  const TWILIO_FROM   = process.env.TWILIO_FROM_NUMBER;
  const FROM_EMAIL    = 'fishing@tamparoughriders.org';
  const AUCTION_URL   = 'https://roughriders-auction.netlify.app';

  async function sbFetch(path, opts = {}) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: {
        'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json', 'Prefer': opts.prefer || 'return=representation',
        ...opts.headers
      },
      method: opts.method || 'GET',
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    const text = await res.text();
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

  // Find item by token
  const items = await sbFetch(`auction_items?winner_token=eq.${encodeURIComponent(token)}&select=*`);
  const item = items?.[0];
  if (!item) return { statusCode: 404, body: JSON.stringify({ ok: false, msg: 'Invalid or expired confirmation link.' }) };

  if (item.winner_status === 'confirmed' || item.winner_status === 'declined') {
    return { statusCode: 200, body: JSON.stringify({ ok: true, alreadyActed: true, action: item.winner_status, title: item.title }) };
  }

  // Check deadline
  if (item.winner_deadline && new Date() > new Date(item.winner_deadline) && action === 'confirm') {
    return { statusCode: 200, body: JSON.stringify({ ok: false, expired: true, msg: 'Confirmation deadline has passed.' }) };
  }

  // Update status
  const newStatus = action === 'confirm' ? 'confirmed' : 'declined';
  await sbFetch(`auction_items?id=eq.${item.id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: { winner_status: newStatus }
  });

  // Notify admins
  try {
    const settingsRes = await sbFetch(`auction_settings?key=eq.admin_notif_recipients&select=value`);
    const admins = settingsRes?.[0]?.value ? JSON.parse(settingsRes[0].value) : [];

    const emoji = action === 'confirm' ? '✅' : '❌';
    const verb  = action === 'confirm' ? 'CONFIRMED their win' : 'DECLINED their win';
    const adminHtml = `
<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f9fafb;margin:0;padding:0">
<div style="max-width:520px;margin:32px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08)">
  <div style="background:${action==='confirm'?'#15803d':'#dc2626'};padding:24px;text-align:center">
    <h1 style="color:#ffffff;font-size:22px;margin:0;font-weight:700">${emoji} Winner ${action === 'confirm' ? 'Confirmed' : 'Declined'}</h1>
  </div>
  <div style="padding:28px">
    <p style="color:#374151;font-size:15px;line-height:1.6">
      <strong>${item.winner_name}</strong> has <strong>${verb}</strong> on <strong>"${item.title}"</strong>
      (winning bid: <strong>$${item.winner_bid?.toLocaleString()}</strong>).
    </p>
    ${action === 'decline' ? '<p style="color:#dc2626;font-size:14px;margin-top:12px">⚠️ You may want to contact the next highest bidder. Log into the admin panel to review bids.</p>' : '<p style="color:#15803d;font-size:14px;margin-top:12px">💰 Arrange payment collection at or before the tournament.</p>'}
    <div style="text-align:center;margin-top:20px">
      <a href="${AUCTION_URL}" style="background:#1e3a5f;color:#ffffff;font-weight:600;font-size:14px;padding:12px 28px;border-radius:8px;text-decoration:none;display:inline-block">Open Admin Panel</a>
    </div>
  </div>
</div>
</body></html>`;

    for (const admin of admins) {
      const channel = admin.viaEmail && admin.viaText ? 'both' : admin.viaText ? 'text' : 'email';
      if ((channel === 'email' || channel === 'both') && admin.email) {
        await sendEmail(admin.email, `${emoji} Winner ${action === 'confirm' ? 'confirmed' : 'declined'}: "${item.title}"`, adminHtml).catch(() => {});
      }
      if ((channel === 'text' || channel === 'both') && admin.phone) {
        const sms = `RR Auction: ${item.winner_name} ${verb} on "${item.title}" ($${item.winner_bid}). ${action === 'decline' ? 'Next bidder may need to be contacted.' : 'Arrange payment.'}`;
        let phone = admin.phone.replace(/\D/g, '');
        if (phone.length === 10) phone = '+1' + phone;
        await sendSMS('+' + phone, sms).catch(() => {});
      }
    }
  } catch(e) {}

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, action, title: item.title, winner: item.winner_name, amount: item.winner_bid })
  };
};
