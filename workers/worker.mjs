// workers/worker.mjs
import { handleRequest } from './src/main.mjs';

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (err) {
      // final fallback
      return new Response(JSON.stringify({
        error: 'server_error',
        detail: (err && err.message) || String(err),
      }), { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' }});
    }
  }
};
