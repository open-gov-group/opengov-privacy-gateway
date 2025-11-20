// workers/libs/secure.mjs
import { json } from './base.mjs';

export async function requireApiKey(request, env) {
  // Im Mock-Mode ohne Auth
  if ((env.MODE || '').startsWith('mock')) {
    return { ok: true };
  }
  const key = request.headers.get('x-api-key');
  if (!key || key !== env.APP_API_KEY) {
    return { ok: false, response: json({ error: 'unauthorized' }, 401) };
  }
  return { ok: true };
}

// JWT-Prüfung (Platzhalter)
export async function verifyJWT(token, env) {
  // TODO: HMAC/HS256 oder Public Key prüfen
  return { ok: !!token };
}
