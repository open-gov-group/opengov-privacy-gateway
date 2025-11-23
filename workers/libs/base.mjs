// workers/libs/base.mjs
export const hdr = {
  json: { 'content-type': 'application/json; charset=utf-8' },
  cors: {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type,authorization,x-api-key',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  }
};

export function withCORS(init = {}) {
  return { ...init, headers: { ...(init.headers||{}), ...hdr.cors }};
}
export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...hdr.json, ...hdr.cors, ...extraHeaders }
  });
}

export function okOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
      "access-control-allow-headers": "content-type,authorization,x-api-key",
      "cache-control": "public, max-age=60, s-maxage=600",
    },
  });
}
export const ok = (b) => json(b, 200);
export const notFound = (msg='not_found') => json({ error:'not_found', detail: msg }, 404);
export const badRequest = (msg='bad_request') => json({ error:'bad_request', detail: msg }, 400);
export const serverErr = (msg='server_error') => json({ error:'server_error', detail: msg }, 500);
export const corsPreflight = () => new Response(null, { status: 204, headers: { ...hdr.cors } });

export function parseUrl(request) {
  const url = new URL(request.url);
  return { url, pathname: url.pathname, searchParams: url.searchParams };
}

export const sanitizeId = (s) => String(s || '').trim().replace(/[^a-zA-Z0-9._-]/g, '');

// libs/base.mjs
// Kleine Fetch-Wrapper mit klaren Fehlern + JSON-Fallback

export async function fetchText(url, init = {}) {
  const r = await fetch(url, init);
  if (!r.ok) {
    throw new Error(`fetchText: ${r.status} ${r.statusText} for ${url}`);
  }
  return await r.text();
}

export async function fetchJson(url, init = {}) {
  const r = await fetch(url, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.headers || {})
    }
  });
  if (!r.ok) {
    throw new Error(`fetchJson: ${r.status} ${r.statusText} for ${url}`);
  }
  return await r.json();
}

// „Safe“: gibt bei Parsefehlern null zurück statt Exception
export async function fetchJsonSafe(url, init = {}) {
  const r = await fetch(url, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.headers || {})
    }
  });
  if (!r.ok) return null;
  const txt = await r.text();
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}
