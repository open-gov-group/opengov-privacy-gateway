// workers/src/main.mjs
import { route } from './router.mjs';
import { corsPreflight, json } from '../libs/base.mjs';

export async function handleRequest(request, env, ctx) {
  // CORS Preflight
  if (request.method === 'OPTIONS') {
    return corsPreflight();
  }
  // Router ausführen
  const res = await route(request, env, ctx);
  // Fallback 404, wenn Router nichts matcht
  if (!res) {
    return json({ error: 'not_found' }, 404);
  }
  return res;
}
