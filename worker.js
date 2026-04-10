const LOOPS_BASE = 'https://app.loops.so/api/v1';
const ALLOWED_ORIGIN = 'https://yachtmesh.com';

function cors(origin) {
  const allowed = origin === ALLOWED_ORIGIN || origin === 'http://localhost';
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

async function verifyTurnstile(token, secret, ip) {
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret, response: token, remoteip: ip }),
  });
  const data = await res.json();
  return data.success === true;
}

async function loopsFetch(path, body, apiKey) {
  const res = await fetch(LOOPS_BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return new Response(JSON.stringify(data), {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = cors(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers });
    }

    // Rate limit by IP: 5 requests per minute
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success: rateLimitOk } = await env.RATE_LIMITER.limit({ key: ip });
    if (!rateLimitOk) {
      return new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers });
    }

    const url = new URL(request.url);
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers });
    }

    // Verify Turnstile token
    const turnstileOk = await verifyTurnstile(body.turnstileToken, env.TURNSTILE_SECRET_KEY, ip);
    if (!turnstileOk) {
      return new Response(JSON.stringify({ error: 'CAPTCHA failed' }), { status: 403, headers });
    }

    let res;
    if (url.pathname === '/waitlist') {
      res = await loopsFetch('/contacts/create', { email: body.email, source: 'waitlist' }, env.LOOPS_API_KEY);
    } else if (url.pathname === '/contact') {
      const [firstName, ...rest] = (body.name || '').split(' ');
      await loopsFetch('/contacts/create', {
        email: body.email,
        firstName,
        lastName: rest.join(' ') || undefined,
        source: 'contact-form',
      }, env.LOOPS_API_KEY);
      res = await loopsFetch('/events/send', {
        email: body.email,
        eventName: 'contactFormSubmission',
        eventProperties: { name: body.name, message: body.message },
      }, env.LOOPS_API_KEY);
    } else {
      return new Response('Not found', { status: 404, headers });
    }

    const resBody = await res.text();
    return new Response(resBody, {
      status: res.status,
      headers: { ...Object.fromEntries(res.headers), ...headers },
    });
  },
};
