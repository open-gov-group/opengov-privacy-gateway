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
