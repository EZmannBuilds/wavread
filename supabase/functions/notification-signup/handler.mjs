const ORIGINS = new Set(['https://wavread.com', 'https://www.wavread.com']);
const PREVIEW = /^https:\/\/wavread-[a-z0-9]+-lorehouse-team\.vercel\.app$/;

export function createHandler({url, key, fetcher = fetch}) {
  return async request => {
    const origin = request.headers.get('origin') || '';
    const allowed = ORIGINS.has(origin) || PREVIEW.test(origin);
    const headers = {'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'Vary': 'Origin', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization, apikey, content-type'};
    if (allowed) headers['Access-Control-Allow-Origin'] = origin;
    const reply = (status, body) => new Response(JSON.stringify(body), {status, headers});
    if (!allowed) return reply(403, {error: 'Please sign up at wavread.com.'});
    if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers});
    if (request.method !== 'POST') return reply(405, {error: 'Use the signup form.'});
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      return reply(415, {error: 'The signup must be sent as JSON.'});
    }
    let raw = '', size = 0, body;
    try {
      const reader = request.body?.getReader();
      if (!reader) return reply(400, {error: 'Enter a valid email address.'});
      const decoder = new TextDecoder();
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) { await reader.cancel(); return reply(413, {error: 'The signup is too large.'}); }
        raw += decoder.decode(value, {stream: true});
      }
      body = JSON.parse(raw + decoder.decode());
    } catch { return reply(400, {error: 'Enter a valid email address.'}); }
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      (body.marketing_opt_in !== undefined && typeof body.marketing_opt_in !== 'boolean')) {
      return reply(400, {error: 'Enter a valid email address and notification preference.'});
    }
    if (!url || !key) return reply(503, {error: 'Signups are temporarily unavailable. Please try again shortly.'});
    try {
      // The public JWT gate is enabled by Supabase. Database credentials never
      // leave this function. Only keyed digests enter short-lived rate buckets.
      const hmac = await crypto.subtle.importKey('raw', new TextEncoder().encode(key),
        {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
      const digest = async value => [...new Uint8Array(await crypto.subtle.sign('HMAC', hmac,
        new TextEncoder().encode(value)))].map(v => v.toString(16).padStart(2, '0')).join('');
      const ip = (request.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim().slice(0, 128);
      const response = await fetcher(`${url}/rest/v1/rpc/record_wavread_notification_signup`, {
        method: 'POST', signal: AbortSignal.timeout(10000),
        headers: {'Authorization': `Bearer ${key}`, 'apikey': key, 'Content-Type': 'application/json'},
        body: JSON.stringify({signup_email: email, marketing: body.marketing_opt_in === true,
          ip_digest: await digest(`ip:${ip}`), email_digest: await digest(`email:${email}`)})
      });
      if (!response.ok) throw new Error('storage');
      const accepted = await response.json();
      if (accepted === false) return reply(429, {error: 'Too many requests. Please try again later.'});
      if (accepted !== true) throw new Error('storage');
      // Same response for a new address, a duplicate, or a suppressed address.
      return reply(200, {saved: true, message: 'Thanks — your Windows notification request has been received.'});
    } catch {
      console.error('notification signup storage unavailable');
      return reply(503, {error: 'Your request could not be saved. Please try again shortly.'});
    }
  };
}
