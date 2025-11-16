var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.mjs
var JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
  "cache-control": "public, max-age=60, s-maxage=600"
};
var ok = /* @__PURE__ */ __name((data, headers = {}) => new Response(JSON.stringify(data), { status: 200, headers: { ...JSON_HEADERS, ...headers } }), "ok");
var notFound = /* @__PURE__ */ __name((msg = "not_found") => new Response(JSON.stringify({ error: "not_found", detail: msg }), { status: 404, headers: JSON_HEADERS }), "notFound");
var badReq = /* @__PURE__ */ __name((msg) => new Response(JSON.stringify({ error: "bad_request", detail: msg }), { status: 400, headers: JSON_HEADERS }), "badReq");
var serverErr = /* @__PURE__ */ __name((msg) => new Response(JSON.stringify({ error: "server_error", detail: msg }), { status: 500, headers: JSON_HEADERS }), "serverErr");
function sanitizeId(s) {
  return String(s || "").trim().replace(/[^a-zA-Z0-9._-]/g, "");
}
__name(sanitizeId, "sanitizeId");
function nowStamp() {
  return (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
}
__name(nowStamp, "nowStamp");
async function fetchJson(url, init = {}) {
  const resp = await fetch(url, init);
  if (!resp.ok) return { ok: false, status: resp.status, data: null };
  const data = await resp.json();
  return { ok: true, status: resp.status, data, headers: resp.headers };
}
__name(fetchJson, "fetchJson");
async function getSSP(env, org, proc) {
  const id = sanitizeId(proc);
  if (env.MODE === "mock") {
    const raw = `${env.MOCK_BASE}/build/${id}.json`;
    return fetchJson(raw, { cf: { cacheTtl: 600, cacheEverything: true } });
  }
  const pOrg = sanitizeId(org);
  const url = `https://raw.githubusercontent.com/${env.DATA_OWNER}/${env.DATA_REPO}/${env.DATA_BASE}/tenants/${pOrg}/procedures/${id}/ssp.json`;
  return fetchJson(url, { cf: { cacheTtl: 300, cacheEverything: true } });
}
__name(getSSP, "getSSP");
async function getRoPA(env, org) {
  const pOrg = sanitizeId(org);
  if (env.MODE === "mock") {
    const raw = `${env.MOCK_BASE}/build/ropa.${pOrg}.json`;
    return fetchJson(raw, { cf: { cacheTtl: 600, cacheEverything: true } });
  }
  const url = `https://raw.githubusercontent.com/${env.DATA_OWNER}/${env.DATA_REPO}/${env.DATA_BASE}/tenants/${pOrg}/ropa/ropa.json`;
  return fetchJson(url, { cf: { cacheTtl: 300, cacheEverything: true } });
}
__name(getRoPA, "getRoPA");
async function getProfileIfAny(ssp) {
  const href = ssp?.["system-security-plan"]?.["import-profile"]?.href;
  if (!href) return { ok: true, data: null };
  return fetchJson(href, { cf: { cacheTtl: 900, cacheEverything: true } });
}
__name(getProfileIfAny, "getProfileIfAny");
async function ensureBranch(env, baseBranch, newBranch) {
  const refResp = await fetch(
    `https://api.github.com/repos/${env.DATA_OWNER}/${env.DATA_REPO}/git/ref/heads/${baseBranch}`,
    { headers: { authorization: `Bearer ${env.GH_TOKEN_DATA}`, "content-type": "application/json" } }
  );
  if (!refResp.ok) return null;
  const ref = await refResp.json();
  const mk = await fetch(
    `https://api.github.com/repos/${env.DATA_OWNER}/${env.DATA_REPO}/git/refs`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${env.GH_TOKEN_DATA}`, "content-type": "application/json" },
      body: JSON.stringify({ ref: `refs/heads/${newBranch}`, sha: ref.object.sha })
    }
  );
  if (mk.status === 422) return newBranch;
  if (!mk.ok) return null;
  return newBranch;
}
__name(ensureBranch, "ensureBranch");
async function putFile(env, branch, pathInRepo, contentJson, message) {
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(contentJson, null, 2))));
  const url = `https://api.github.com/repos/${env.DATA_OWNER}/${env.DATA_REPO}/contents/${encodeURIComponent(pathInRepo)}`;
  const resp = await fetch(url + `?ref=${encodeURIComponent(branch)}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${env.GH_TOKEN_DATA}`, "content-type": "application/json" },
    body: JSON.stringify({ message, content, branch })
  });
  return resp.ok ? await resp.json() : null;
}
__name(putFile, "putFile");
async function openPR(env, branch, title, body, base = "main") {
  const resp = await fetch(
    `https://api.github.com/repos/${env.DATA_OWNER}/${env.DATA_REPO}/pulls`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${env.GH_TOKEN_DATA}`, "content-type": "application/json" },
      body: JSON.stringify({ title, head: branch, base, body })
    }
  );
  return resp.ok ? await resp.json() : null;
}
__name(openPR, "openPR");
var worker_default = {
  async fetch(request, env) {
    try {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: JSON_HEADERS });
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === "/healthz") return ok({ ok: true });
      if (path === "/mode") return ok({ mode: env.MODE || "mock" });
      let m = path.match(/^\/api\/ssp\/([^/]+)\/([^/]+)$/);
      if (request.method === "GET" && m) {
        const [_, org, proc] = m;
        const s = await getSSP(env, org, proc);
        if (!s.ok) return notFound(`ssp ${org}/${proc}`);
        return ok(s.data);
      }
      m = path.match(/^\/api\/ssp-bundle\/([^/]+)\/([^/]+)$/);
      if (request.method === "GET" && m) {
        const [_, org, proc] = m;
        const s = await getSSP(env, org, proc);
        if (!s.ok) return notFound(`ssp ${org}/${proc}`);
        const p = await getProfileIfAny(s.data);
        return ok({ ssp: s.data, profile: p?.data || null });
      }
      m = path.match(/^\/api\/ropa\/([^/]+)$/);
      if (request.method === "GET" && m) {
        const org = m[1];
        const r = await getRoPA(env, org);
        if (!r.ok) return notFound(`ropa ${org}`);
        return ok(r.data);
      }
      m = path.match(/^\/api\/ssp\/([^/]+)\/([^/]+)$/);
      if (request.method === "POST" && m) {
        if (!env.GH_TOKEN_DATA) return serverErr("GH_TOKEN_DATA not configured");
        const [_, org, proc] = m;
        let body;
        try {
          body = await request.json();
        } catch {
          return badReq("Body must be valid JSON");
        }
        if (!body?.["system-security-plan"]) return badReq("Missing 'system-security-plan' root");
        const branch = `update/${sanitizeId(org)}-${sanitizeId(proc)}-${nowStamp()}`;
        const okBranch = await ensureBranch(env, env.DATA_BASE || "main", branch);
        if (!okBranch) return serverErr("Failed to create branch");
        const pathInRepo = `tenants/${sanitizeId(org)}/procedures/${sanitizeId(proc)}/ssp.json`;
        const msg = `chore(ssp): update ${org}/${proc} via API`;
        const put = await putFile(env, branch, pathInRepo, body, msg);
        if (!put) return serverErr("Failed to write file");
        const title = `Update SSP: ${org}/${proc}`;
        const prBody = `Automated update via API (${(/* @__PURE__ */ new Date()).toISOString()})`;
        const pr = await openPR(env, branch, title, prBody, env.DATA_BASE || "main");
        if (!pr) return serverErr("Failed to open PR");
        return ok({ ok: true, pr_url: pr.html_url, branch, path: pathInRepo });
      }
      if (path === "/") {
        return ok({
          name: "open-privacy-api",
          mode: env.MODE,
          endpoints: [
            "GET  /healthz",
            "GET  /mode",
            "GET  /api/ssp/:org/:proc",
            "GET  /api/ssp-bundle/:org/:proc",
            "GET  /api/ropa/:org",
            "POST /api/ssp/:org/:proc"
          ],
          example: "/api/ssp-bundle/demo-org/emr-auskunft"
        });
      }
      if (path === "/help") {
        return ok({
          mockBase: env.MOCK_BASE,
          expects: `${env.MOCK_BASE}/build/<proc>.json`,
          tip: "Benutze einen <proc>-Namen, der zu einer existierenden Datei im build/-Ordner passt."
        });
      }
      return new Response("Not found", { status: 404, headers: JSON_HEADERS });
    } catch (e) {
      return serverErr(String(e?.message || e));
    }
  }
};

// C:/Users/kemde/AppData/Roaming/npm/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// C:/Users/kemde/AppData/Roaming/npm/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-9o7Fkp/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// C:/Users/kemde/AppData/Roaming/npm/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-9o7Fkp/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
