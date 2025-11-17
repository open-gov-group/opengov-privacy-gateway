// Cloudflare Worker: Read (mock/prod) + Write (PR ins Data-Repo)
//
// GET  /healthz
// GET  /mode
// GET  /api/ssp/:org/:proc
// GET  /api/ssp-bundle/:org/:proc     -> { ssp, profile }
// GET  /api/ropa/:org
// POST /api/ssp/:org/:proc            -> PR in DATA_REPO (Body: SSP JSON)
//
// ENV-Vars in wrangler.toml ([vars]) und Secret GH_TOKEN_DATA.

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
  "cache-control": "public, max-age=60, s-maxage=600"
};

const unauthorized = (msg = "unauthorized") =>
  new Response(JSON.stringify({ error: "unauthorized", detail: msg }), {
    status: 401,
    headers: JSON_HEADERS
  });

const ok = (data, headers = {}) =>
  new Response(JSON.stringify(data), { status: 200, headers: { ...JSON_HEADERS, ...headers } });
const notFound = (msg = "not_found") =>
  new Response(JSON.stringify({ error: "not_found", detail: msg }), { status: 404, headers: JSON_HEADERS });
const badReq = (msg) =>
  new Response(JSON.stringify({ error: "bad_request", detail: msg }), { status: 400, headers: JSON_HEADERS });
const serverErr = (msg) =>
  new Response(JSON.stringify({ error: "server_error", detail: msg }), { status: 500, headers: JSON_HEADERS });

function sanitizeId(s) { return String(s || "").trim().replace(/[^a-zA-Z0-9._-]/g, ""); }
function nowStamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }

// Set ALLOW_ORIGIN in wrangler.toml [vars]
function corsHeaders(env) {
  const h = { ...JSON_HEADERS };
  if (env.ALLOW_ORIGIN) h["access-control-allow-origin"] = env.ALLOW_ORIGIN;
  return h;
}
async function fetchJson(url, init = {}) {
  const resp = await fetch(url, init);
  if (!resp.ok) return { ok: false, status: resp.status, data: null };
  const data = await resp.json();
  return { ok: true, status: resp.status, data, headers: resp.headers };
}

// ---- READ: SSP / RoPA ------------------------------------------------------

async function getSSP(env, org, proc) {
  const id = sanitizeId(proc);
  if (env.MODE === "mock") {
    const raw = `${env.MOCK_BASE}/build/${id}.json`; // opengov-privacy-mappings/build/<proc>.json
    return fetchJson(raw, { cf: { cacheTtl: 600, cacheEverything: true } });
  }
  const pOrg = sanitizeId(org);
  const url = `https://raw.githubusercontent.com/${env.DATA_OWNER}/${env.DATA_REPO}/${env.DATA_BASE}/tenants/${pOrg}/procedures/${id}/ssp.json`;
  return fetchJson(url, { cf: { cacheTtl: 300, cacheEverything: true } });
}

async function getRoPA(env, org) {
  const pOrg = sanitizeId(org);
  if (env.MODE === "mock") {
    const raw = `${env.MOCK_BASE}/build/ropa.${pOrg}.json`; // optionaler Mock
    return fetchJson(raw, { cf: { cacheTtl: 600, cacheEverything: true } });
  }
  const url = `https://raw.githubusercontent.com/${env.DATA_OWNER}/${env.DATA_REPO}/${env.DATA_BASE}/tenants/${pOrg}/ropa/ropa.json`;
  return fetchJson(url, { cf: { cacheTtl: 300, cacheEverything: true } });
}

async function getProfileIfAny(ssp) {
  const href = ssp?.["system-security-plan"]?.["import-profile"]?.href;
  if (!href) return { ok: true, data: null };
  return fetchJson(href, { cf: { cacheTtl: 900, cacheEverything: true } });
}

// ---- WRITE: PR in DATA_REPO -----------------------------------------------

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
  if (mk.status === 422) return newBranch; // existiert bereits
  if (!mk.ok) return null;
  return newBranch;
}

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

// Minimal-JWT-Verify (HS256) ohne Fremdbibliothek
async function verifyJwtHS256(token, secret, { iss, aud } = {}) {
  try {
    const [h64, p64, s64] = token.split(".");
    if (!h64 || !p64 || !s64) return { ok: false, error: "malformed jwt" };

    const enc = str => new TextEncoder().encode(str);
    const b64u = s => s.replace(/-/g, "+").replace(/_/g, "/");
    const toArr = s => Uint8Array.from(atob(b64u(s)), c => c.charCodeAt(0));

    const data = `${h64}.${p64}`;
    const key = await crypto.subtle.importKey(
      "raw", enc(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    const sigOk = await crypto.subtle.verify("HMAC", key, toArr(s64), enc(data));
    if (!sigOk) return { ok: false, error: "bad signature" };

    const payload = JSON.parse(new TextDecoder().decode(toArr(p64)));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && now >= payload.exp) return { ok: false, error: "expired" };
    if (iss && payload.iss !== iss) return { ok: false, error: "bad iss" };
    if (aud && payload.aud !== aud) return { ok: false, error: "bad aud" };
    return { ok: true, payload };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function requireJWT(request, env) {
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return { ok: false, error: "missing bearer token" };
  const token = auth.slice(7).trim();
  if (!env.APP_API_KEY) return { ok: false, error: "APP_API_KEY missing" }; // shared secret (HS256)
  const iss = env.JWT_ISS || "open-privacy";
  const aud = env.JWT_AUD || "open-privacy-api";
  const res = await verifyJwtHS256(token, env.APP_API_KEY, { iss, aud });
  return res;
}





// ---- ROUTER ----------------------------------------------------------------

export default {
  async fetch(request, env) {
    try {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: JSON_HEADERS });

      const url = new URL(request.url);
      const path = url.pathname;

      if (path === "/healthz") return ok({ ok: true });
      if (path === "/mode")   return ok({ mode: env.MODE || "mock" });

      // GET SSP
      let m = path.match(/^\/api\/ssp\/([^/]+)\/([^/]+)$/);
      if (request.method === "GET" && m) {
        const [_, org, proc] = m;
        const s = await getSSP(env, org, proc);
        if (!s.ok) return notFound(`ssp ${org}/${proc}`);
        return ok(s.data);
      }

      // GET SSP bundle
      m = path.match(/^\/api\/ssp-bundle\/([^/]+)\/([^/]+)$/);
      if (request.method === "GET" && m) {
        const [_, org, proc] = m;
        const s = await getSSP(env, org, proc);
        if (!s.ok) return notFound(`ssp ${org}/${proc}`);
        const p = await getProfileIfAny(s.data);
        return ok({ ssp: s.data, profile: p?.data || null });
      }

      // GET RoPA
      m = path.match(/^\/api\/ropa\/([^/]+)$/);
      if (request.method === "GET" && m) {
        const org = m[1];
        const r = await getRoPA(env, org);
        if (!r.ok) return notFound(`ropa ${org}`);
        return ok(r.data);
      }

      // POST SSP (PR)
      m = path.match(/^\/api\/ssp\/([^/]+)\/([^/]+)$/);
      if (request.method === "POST" && m) {
        // 0) Auth FIRST
        const gate = await requireJWT(request, env);
        if (!gate.ok) return unauthorized(gate.error);

        if (!env.GH_TOKEN_DATA) return serverErr("GH_TOKEN_DATA not configured");
        const [_, org, proc] = m;

        // 1) Parse body
        let body;
        try { body = await request.json(); } catch { return badReq("Body must be valid JSON"); }
        if (!body?.["system-security-plan"]) return badReq("Missing 'system-security-plan' root");

        // 2) Git branch
        const branch = `update/${sanitizeId(org)}-${sanitizeId(proc)}-${nowStamp()}`;
        const okBranch = await ensureBranch(env, env.DATA_BASE || "main", branch);
        if (!okBranch) return serverErr("Failed to create branch");

        // 3) Put file
        const pathInRepo = `tenants/${sanitizeId(org)}/procedures/${sanitizeId(proc)}/ssp.json`;
        const msg = `chore(ssp): update ${org}/${proc} via API`;
        const put = await putFile(env, branch, pathInRepo, body, msg);
        if (!put) return serverErr("Failed to write file");

        // 4) PR
        const title = `Update SSP: ${org}/${proc}`;
        const prBody = `Automated update via API (${new Date().toISOString()})`;
        const pr = await openPR(env, branch, title, prBody, env.DATA_BASE || "main");
        if (!pr) return serverErr("Failed to open PR");

        return new Response(JSON.stringify({ ok: true, pr_url: pr.html_url, branch, path: pathInRepo }), {
          status: 200,
          headers: corsHeaders(env)
        });
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
