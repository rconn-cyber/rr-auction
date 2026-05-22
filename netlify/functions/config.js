// netlify/functions/config.js
// Serves public Supabase config to the browser.
// The anon key is safe to expose (it's public by design) but keeping it
// out of source code prevents Netlify's secret-scanning from blocking deploys.
//
// Required env vars:
//   SUPABASE_URL       (already set)
//   SUPABASE_ANON_KEY  (add this — it's the anon/public key, NOT service_role)

exports.handler = async () => {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600'
    },
    body: JSON.stringify({
      supabaseUrl: process.env.SUPABASE_URL || '',
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY || ''
    })
  };
};
