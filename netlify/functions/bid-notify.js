// netlify/functions/bid-notify.js
// Fires after a bid is placed. Sends:
//   - Outbid notification to the previous high bidder
//   - New bid alert to admin recipients per their preferences
//
// Required env vars in Netlify:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
//   RESEND_API_KEY
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const {
    item_id,
    item_title,
    new_bid_amount,
    new_bidder_name,
    new_bidder_email,
    new_bidder_phone,
    new_bidder_notify_outbid,
    new_bidder_notify_win,
    new_bidder_contact_method,
    previous_bidder_name,
    previous_bidder_email,
    previous_bidder_phone,
    previous_bidder_notify_outbid,
    previous_bidder_contact_method,
  } = payload;

  const SUPABASE_URL     = process.env.SUPABASE_URL;
  const SUPABASE_KEY     = process.env.SUPABASE_SERVICE_KEY;
  const RESEND_KEY       = process.env.RESEND_API_KEY;
  const TWILIO_SID       = process.env.TWILIO_ACCOUNT_SID;
  const TWILIO_TOKEN     = process.env.TWILIO_AUTH_TOKEN;
  const TWILIO_FROM      = process.env.TWILIO_FROM_NUMBER;
  const FROM_EMAIL       = 'fishing@tamparoughriders.org';
  const AUCTION_URL      = 'https://roughriders-auction.netlify.app';

  const results = [];

  /* ─────────────────────────────────────────────
     HELPERS
  ───────────────────────────────────────────── */
  async function sendEmail(to, subject, html) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: `Rough Riders Auction <${FROM_EMAIL}>`,
        to: [to],
        subject,
        html
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Resend error: ${JSON.stringify(data)}`);
    return data;
  }

  async function sendSMS(to, body) {
    if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) {
      throw new Error('Twilio env vars not configured');
    }
    // Normalize phone — strip non-digits, prepend +1 if 10 digits
    let phone = to.replace(/\D/g, '');
    if (phone.length === 10) phone = '+1' + phone;
    else if (phone.length === 11 && phone.startsWith('1')) phone = '+' + phone;
    else phone = '+' + phone;

    const params = new URLSearchParams({
      To: phone,
      From: TWILIO_FROM,
      Body: body
    });
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
      }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(`Twilio error: ${JSON.stringify(data)}`);
    return data;
  }

  async function notify(channel, email, phone, subject, emailHtml, smsText) {
    const sends = [];
    if ((channel === 'email' || channel === 'both') && email) {
      sends.push(sendEmail(email, subject, emailHtml).catch(e => `email-err: ${e.message}`));
    }
    if ((channel === 'text' || channel === 'both') && phone) {
      sends.push(sendSMS(phone, smsText).catch(e => `sms-err: ${e.message}`));
    }
    return Promise.all(sends);
  }

  /* ─────────────────────────────────────────────
     EMAIL TEMPLATES
  ───────────────────────────────────────────── */
  function outbidEmailHtml(prevName, itemTitle, newAmount) {
    return `
<!DOCTYPE html><html><body style="font-family:Georgia,serif;background:#f5efe0;margin:0;padding:0">
<div style="max-width:560px;margin:30px auto;background:#ffffff;border:1px solid #d4c5a0;border-top:4px solid #c9a84c;border-radius:6px;overflow:hidden">
  <div style="background:#0d1f3c;padding:20px 24px;text-align:center">
    <p style="color:#c9a84c;font-family:Georgia,serif;font-size:11px;letter-spacing:3px;text-transform:uppercase;margin:0 0 6px">Rough Riders Fishing Tournament</p>
    <h1 style="color:#f0cf70;font-family:Georgia,serif;font-size:22px;margin:0">⚓ Online Auction</h1>
  </div>
  <div style="padding:28px 24px">
    <h2 style="color:#0d1f3c;font-family:Georgia,serif;font-size:18px;margin:0 0 16px">You've Been Outbid</h2>
    <p style="color:#3a4a5a;font-size:15px;line-height:1.6">Hi ${prevName},</p>
    <p style="color:#3a4a5a;font-size:15px;line-height:1.6">
      Someone has placed a higher bid on <strong>${itemTitle}</strong>.
      The current high bid is now <strong style="color:#0d1f3c;font-size:18px">$${newAmount.toLocaleString()}</strong>.
    </p>
    <div style="text-align:center;margin:24px 0">
      <a href="${AUCTION_URL}" style="background:#0d1f3c;color:#c9a84c;font-family:Georgia,serif;font-size:14px;letter-spacing:2px;text-transform:uppercase;padding:14px 32px;border-radius:4px;text-decoration:none;display:inline-block">
        Bid Again — Bully!
      </a>
    </div>
    <p style="color:#6a7a8a;font-size:13px;line-height:1.5">
      Auction closes Saturday, June 20, 2026 at 9:00 PM EDT.<br>
      To stop receiving these notifications, simply don't check "Notify me if outbid" on your next bid.
    </p>
  </div>
  <div style="background:#f5efe0;padding:14px 24px;text-align:center;border-top:1px solid #d4c5a0">
    <p style="color:#8a7a5a;font-size:12px;margin:0">1st U.S. Volunteer Cavalry Regiment – Rough Riders, Inc. &bull; Tampa, FL</p>
  </div>
</div>
</body></html>`;
  }

  function adminBidEmailHtml(adminName, bidderName, itemTitle, amount, bidCount) {
    return `
<!DOCTYPE html><html><body style="font-family:Georgia,serif;background:#f5efe0;margin:0;padding:0">
<div style="max-width:560px;margin:30px auto;background:#ffffff;border:1px solid #d4c5a0;border-top:4px solid #c9a84c;border-radius:6px;overflow:hidden">
  <div style="background:#0d1f3c;padding:20px 24px;text-align:center">
    <p style="color:#c9a84c;font-family:Georgia,serif;font-size:11px;letter-spacing:3px;text-transform:uppercase;margin:0 0 6px">Rough Riders Fishing Tournament</p>
    <h1 style="color:#f0cf70;font-family:Georgia,serif;font-size:22px;margin:0">⚓ Auction — New Bid</h1>
  </div>
  <div style="padding:28px 24px">
    <h2 style="color:#0d1f3c;font-family:Georgia,serif;font-size:18px;margin:0 0 16px">New Bid Placed</h2>
    <p style="color:#3a4a5a;font-size:15px;line-height:1.6">Hi ${adminName},</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0">
      <tr style="background:#f5efe0">
        <td style="padding:10px 12px;font-size:13px;color:#6a7a8a;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #d4c5a0">Item</td>
        <td style="padding:10px 12px;font-size:14px;color:#0d1f3c;border-bottom:1px solid #d4c5a0"><strong>${itemTitle}</strong></td>
      </tr>
      <tr>
        <td style="padding:10px 12px;font-size:13px;color:#6a7a8a;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #d4c5a0">Bidder</td>
        <td style="padding:10px 12px;font-size:14px;color:#0d1f3c;border-bottom:1px solid #d4c5a0">${bidderName}</td>
      </tr>
      <tr style="background:#f5efe0">
        <td style="padding:10px 12px;font-size:13px;color:#6a7a8a;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #d4c5a0">Amount</td>
        <td style="padding:10px 12px;font-size:20px;color:#0d1f3c;border-bottom:1px solid #d4c5a0"><strong>$${amount.toLocaleString()}</strong></td>
      </tr>
      <tr>
        <td style="padding:10px 12px;font-size:13px;color:#6a7a8a;text-transform:uppercase;letter-spacing:1px">Total Bids</td>
        <td style="padding:10px 12px;font-size:14px;color:#0d1f3c">${bidCount}</td>
      </tr>
    </table>
    <div style="text-align:center;margin:20px 0">
      <a href="${AUCTION_URL}" style="background:#0d1f3c;color:#c9a84c;font-family:Georgia,serif;font-size:13px;letter-spacing:2px;text-transform:uppercase;padding:12px 28px;border-radius:4px;text-decoration:none;display:inline-block">
        View Auction
      </a>
    </div>
  </div>
  <div style="background:#f5efe0;padding:14px 24px;text-align:center;border-top:1px solid #d4c5a0">
    <p style="color:#8a7a5a;font-size:12px;margin:0">1st U.S. Volunteer Cavalry Regiment – Rough Riders, Inc. &bull; Tampa, FL</p>
  </div>
</div>
</body></html>`;
  }

  /* ─────────────────────────────────────────────
     1. NOTIFY PREVIOUS HIGH BIDDER (outbid)
  ───────────────────────────────────────────── */
  if (
    previous_bidder_email &&
    previous_bidder_notify_outbid &&
    previous_bidder_email !== new_bidder_email
  ) {
    try {
      const channel = previous_bidder_contact_method || 'email';
      const subject = `You've been outbid on "${item_title}"`;
      const emailHtml = outbidEmailHtml(
        previous_bidder_name || 'Bidder',
        item_title,
        new_bid_amount
      );
      const smsText = `Rough Riders Auction: You've been outbid on "${item_title}". New high bid: $${new_bid_amount}. Bid again: ${AUCTION_URL}`;

      const r = await notify(
        channel,
        previous_bidder_email,
        previous_bidder_phone,
        subject,
        emailHtml,
        smsText
      );
      results.push({ type: 'outbid', to: previous_bidder_email, result: r });
    } catch (e) {
      results.push({ type: 'outbid', error: e.message });
    }
  }

  /* ─────────────────────────────────────────────
     2. NOTIFY ADMIN RECIPIENTS
  ───────────────────────────────────────────── */
  try {
    // Load admin recipients from auction_settings
    const settingsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/auction_settings?key=eq.admin_notif_recipients&select=value`,
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      }
    );
    const settingsRows = await settingsRes.json();
    const adminRecipients = settingsRows?.[0]?.value
      ? JSON.parse(settingsRows[0].value)
      : [];

    // Get total bid count for this item
    const bidsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/auction_bids?item_id=eq.${item_id}&select=id`,
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      }
    );
    const bids = await bidsRes.json();
    const bidCount = bids?.length || 1;
    const isNewHigh = true; // every bid placed via the app is a new high (enforced by min increment)

    for (const admin of adminRecipients) {
      const shouldNotify = admin.allBids || (admin.newHigh && isNewHigh);
      if (!shouldNotify) continue;

      const channel = admin.viaEmail && admin.viaText ? 'both'
        : admin.viaText ? 'text'
        : 'email';

      const subject = `New bid: $${new_bid_amount} on "${item_title}"`;
      const emailHtml = adminBidEmailHtml(
        admin.name || 'Admin',
        new_bidder_name,
        item_title,
        new_bid_amount,
        bidCount
      );
      const smsText = `RR Auction: ${new_bidder_name} bid $${new_bid_amount} on "${item_title}" (${bidCount} bids). ${AUCTION_URL}`;

      try {
        const r = await notify(channel, admin.email, admin.phone, subject, emailHtml, smsText);
        results.push({ type: 'admin', to: admin.email || admin.phone, result: r });
      } catch (e) {
        results.push({ type: 'admin', to: admin.name, error: e.message });
      }
    }
  } catch (e) {
    results.push({ type: 'admin-load', error: e.message });
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, results })
  };
};
