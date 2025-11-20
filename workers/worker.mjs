// Cloudflare Worker: Gateway for OSCAL Privacy
// READ (mock/prod) + WRITE (PR to Data Repo) + Resolve Profiles + Templates + Fixtures + Evidence verify
//
// GET  /healthz
// GET  /mode
// GET  /api/catalogs
// GET  /api/profiles
// GET  /api/profile-resolved?href=<url>
// GET  /api/templates/ssp
// GET  /api/fixtures
// GET  /api/ssp/:org/:proc
// GET  /api/ssp-bundle/:org/:proc     -> { ssp, profile }
// GET  /api/ropa/:org
// POST /api/ssp/:org/:proc            -> PR in DATA_REPO (Body: SSP JSON)
// POST /api/evidence/verify           -> { ok, status, mediaType?, hash? }
//
// ENV in wrangler.toml ([vars]) + Secret GH_TOKEN_DATA
// Required/used vars:
// MODE=("mock"|"prod")                 default "mock"
// ALLOW_ORIGIN="*"                     CORS
// MOCK_BASE="https://raw.githubusercontent.com/open-gov-group/opengov-privacy-mappings/main"
// DATA_OWNER="open-gov-group"
// DATA_REPO="opengov-privacy-data"
// DATA_BASE="main"
// APP_API_KEY="<shared-secret-hs256>"
// JWT_ISS="open-privacy"               (optional)
// JWT_AUD="open-privacy-api"           (optional)
// CATALOG_INDEX_URL="<url to JSON index>" (optional)
// PROFILE_INDEX_URL="<url to JSON index>" (optional)
// DEFAULT_PROFILE_HREF="<profile href default>" (optional)
// TEMPLATE_SSP_HREF="<url to JSON template>" (optional)

// gateway/worker.mjs – Handler hinzufügen:
import { buildOrgId } from './lib/org-id.mjs'; // selbe Logik wie im UI


const JSON_HEADERS_BASE = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,x-api-key",
  "cache-control": "public, max-age=60, s-maxage=600"
};

const ok = (env, data, extra = {}) =>
  new Response(JSON.stringify(data), { status: 200, headers: { ...makeCors(env), ...extra } });

const notFound = (env, msg = "not_found") =>
  new Response(JSON.stringify({ error: "not_found", detail: msg }), { status: 404, headers: makeCors(env) });

const badReq = (env, msg) =>
  new Response(JSON.stringify({ error: "bad_request", detail: msg }), { status: 400, headers: makeCors(env) });

const unauthorized = (env, msg = "unauthorized") =>
  new Response(JSON.stringify({ error: "unauthorized", detail: msg }), { status: 401, headers: makeCors(env) });

const serverErr = (env, msg) =>
  new Response(JSON.stringify({ error: "server_error", detail: msg }), { status: 500, headers: makeCors(env) });

function makeCors(env) {
  const h = { ...JSON_HEADERS_BASE };
  h["access-control-allow-origin"] = env.ALLOW_ORIGIN || "*";
  return h;
}

function json(env, status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: makeCors(env) });
}

function sanitizeId(s) { return String(s || "").trim().replace(/[^a-zA-Z0-9._-]/g, ""); }
function nowStamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }

async function fetchJson(url, init = {}) {
  const resp = await fetch(url, init);
  if (!resp.ok) return { ok: false, status: resp.status, data: null, headers: resp.headers };
  const data = await resp.json();
  return { ok: true, status: resp.status, data, headers: resp.headers };
}

async function fetchHead(url, init = {}) {
  const resp = await fetch(url, { method: "HEAD", ...init });
  return resp;
}

async function fetchArrayBuffer(url, init = {}) {
  const resp = await fetch(url, init);
  if (!resp.ok) return null;
  const buf = await resp.arrayBuffer();
  return { buf, headers: resp.headers, status: resp.status };
}

// ---------- READ: SSP / RoPA (mock/prod) ------------------------------------

async function getSSP(env, org, proc) {
  const id = sanitizeId(proc);
  if ((env.MODE || "mock") === "mock") {
    // Expect mapping build artifacts: /build/<proc>.json
    const raw = `${env.MOCK_BASE}/build/${id}.json`;
    return fetchJson(raw, { cf: { cacheTtl: 600, cacheEverything: true } });
  }
  const pOrg = sanitizeId(org);
  const url = `https://raw.githubusercontent.com/${env.DATA_OWNER}/${env.DATA_REPO}/${env.DATA_BASE}/tenants/${pOrg}/procedures/${id}/ssp.json`;
  return fetchJson(url, { cf: { cacheTtl: 300, cacheEverything: true } });
}

async function getRoPA(env, org) {
  const pOrg = sanitizeId(org);
  if ((env.MODE || "mock") === "mock") {
    const raw = `${env.MOCK_BASE}/build/ropa.${pOrg}.json`; // optional
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

// ---------- NEW: Catalogs / Profiles / Resolver / Templates / Fixtures ------

async function listCatalogs(env) {
  // Option A: Externe Index-Datei (JSON) aus OSCAL-Repo
  if (env.CATALOG_INDEX_URL) {
    const r = await fetchJson(env.CATALOG_INDEX_URL, { cf: { cacheTtl: 600, cacheEverything: true } });
    if (r.ok) return r.data;
  }
  // Option B: Fallback statisch (kannst du später ersetzen)
  return [
    {
      id: "opengov-privacy",
      title: "OpenGov Privacy Catalog",
      version: "0.2.0",
      href_resolved: "https://raw.githubusercontent.com/open-gov-group/opengov-privacy-oscal/main/build/profile_resolved_catalog.json",
      href_catalog: "https://raw.githubusercontent.com/open-gov-group/opengov-privacy-oscal/main/oscal/catalog/opengov_privacy_catalog.json"
    }
  ];
}

async function listProfiles(env) {
  // Option A: Externe Index-Datei (JSON) aus OSCAL-Repo
  if (env.PROFILE_INDEX_URL) {
    const r = await fetchJson(env.PROFILE_INDEX_URL, { cf: { cacheTtl: 600, cacheEverything: true } });
    if (r.ok) return r.data;
  }
  // Option B: Fallback statisch
  return [
    {
      id: "intervenability",
      title: "Intervenability (SDM)",
      href: "https://raw.githubusercontent.com/open-gov-group/opengov-privacy-oscal/main/oscal/profiles/profile_intervenability.json",
      resolved: false
    },
    {
      id: "data-minimization",
      title: "Data Minimization (SDM)",
      href: "https://raw.githubusercontent.com/open-gov-group/opengov-privacy-oscal/main/oscal/profiles/profile_data_minimization.json",
      resolved: false
    },
    {
      id: "confidentiality",
      title: "Confidentiality (SDM)",
      href: "https://raw.githubusercontent.com/open-gov-group/opengov-privacy-oscal/main/oscal/profiles/profile_confidentiality.json",
      resolved: false
    }
  ];
}

async function resolveProfile(env, href) {
  // Aktuell: pass-through (wir liefern das referenzierte JSON). Später: echtes "resolve" (include/alter anwenden)
  if (!href) return { ok: false, status: 400, data: { error: "missing href" } };
  return fetchJson(href, { cf: { cacheTtl: 900, cacheEverything: true } });
}

async function buildSSPTemplate(env, profileHref) {
  // Kandidaten-Reihenfolge zum Laden aus dem OSCAL-Repo (konfigurierbar → Default)
  const candidates = [];
  if (env.TEMPLATE_SSP_HREF) candidates.push(env.TEMPLATE_SSP_HREF);

  // sinnvoller Default im opengov-privacy-oscal Repo
  candidates.push(
    "https://raw.githubusercontent.com/open-gov-group/opengov-privacy-oscal/main/oscal/ssp/ssp_template_ropa.json"
  );

  // Versuche nacheinander zu laden
  for (const href of candidates) {
    try {
      const r = await fetch(href, { cf: { cacheTtl: 300, cacheEverything: true } });
      if (!r.ok) continue;
      const tpl = await r.json();

      // Sicherheitsnetz: Root prüfen
      const root = tpl && tpl["system-security-plan"] ? tpl : null;
      if (!root) continue;

      // Profil injizieren, falls gewünscht und noch nicht gesetzt
      if (profileHref) {
        const hasImport = !!root["system-security-plan"]["import-profile"];
        if (!hasImport) {
          root["system-security-plan"]["import-profile"] = { href: profileHref };
        }
      }

      //  Minimale Pflichtfelder sicherstellen (falls Template dünn ist)
      const ssp = root["system-security-plan"];
      ssp.metadata = ssp.metadata || {};
      ssp.metadata["oscal-version"] = ssp.metadata["oscal-version"] || "1.1.2";
      ssp.metadata["last-modified"] = ssp.metadata["last-modified"] || new Date().toISOString();
      ssp.uuid = ssp.uuid || crypto.randomUUID();

      ssp["system-characteristics"] = ssp["system-characteristics"] || {
        "system-ids": [{ "identifier-type": "assigned", id: "SSP-RoPA-XXX" }],
        "system-name": "Processing activity – <Title>",
        "system-name-short": "PA-<Short>",
        description: "Short description of the processing, purpose, legal basis, categories of data subjects/data.",
        status: { state: "operational" },
        "security-sensitivity-level": "moderate",
        "system-information": {
          "information-types": [{ title: "Personal data (GDPR)", description: "Typical RoPA categories." }]
        },
        props: [
          { name: "ropa:purpose", value: "<purpose(s)>" },
          { name: "ropa:data-categories", value: "<categories of personal data>" },
          { name: "ropa:data-subjects", value: "<data subject categories>" },
          { name: "ropa:recipients", value: "<recipients/categories>" },
          { name: "ropa:third-country-transfers", value: "<No/Yes – legal basis>" },
          { name: "ropa:retention", value: "<retention/erasure periods>" },
          { name: "ropa:legal-basis", value: "<Art. 6 GDPR / sector law>" }
        ],
        "authorization-boundary": { description: "Scope and boundary of the processing environment." }
      };

      ssp["system-implementation"] = ssp["system-implementation"] || { users: [], components: [] };
      ssp["control-implementation"] = ssp["control-implementation"] || {
        description: "Implementation of controls per profile/catalog; reference components and evidence.",
        "implemented-requirements": []
      };
      ssp["back-matter"] = ssp["back-matter"] || { resources: [] };

      return root; // erfolgreich geladen + ggf. angereichert
    } catch (_) {
      // nächste Quelle probieren
    }
  }

  // ROBUSTES FALLBACK
  return {
    "system-security-plan": {
      uuid: crypto.randomUUID(),
      metadata: {
        title: "SSP (RoPA) – Template",
        "last-modified": new Date().toISOString(),
        version: "0.2.0",
        "oscal-version": "1.1.2"
      },
      ...(profileHref ? { "import-profile": { href: profileHref } } : {}),
      "system-characteristics": {
        "system-ids": [{ "identifier-type": "assigned", id: "SSP-RoPA-XXX" }],
        "system-name": "Processing activity – <Title>",
        "system-name-short": "PA-<Short>",
        description: "Short description of the processing, purpose, legal basis, categories of data subjects/data.",
        status: { state: "operational" },
        "security-sensitivity-level": "moderate",
        "system-information": {
          "information-types": [{ title: "Personal data (GDPR)", description: "Typical RoPA categories." }]
        },
        props: [
          { name: "ropa:purpose", value: "<purpose(s)>" },
          { name: "ropa:data-categories", value: "<categories of personal data>" },
          { name: "ropa:data-subjects", value: "<data subject categories>" },
          { name: "ropa:recipients", value: "<recipients/categories>" },
          { name: "ropa:third-country-transfers", value: "<No/Yes – legal basis>" },
          { name: "ropa:retention", value: "<retention/erasure periods>" },
          { name: "ropa:legal-basis", value: "<Art. 6 GDPR / sector law>" }
        ],
        "authorization-boundary": { description: "Scope and boundary of the processing environment." }
      },
      "system-implementation": { users: [], components: [] },
      "control-implementation": {
        description: "Implementation of controls per profile/catalog; reference components and evidence.",
        "implemented-requirements": []
      },
      "back-matter": { resources: [] }
    }
  };
}


function fixtures(env) {
  return {
    xdomeaXmlUrl: `${env.MOCK_BASE}/examples/xdomea_valid.xml`,
    bpmnUrl:      `${env.MOCK_BASE}/examples/bpmn_emr.bpmn`,
    cimUrl:       `${env.MOCK_BASE}/build/cim.json`,
    sspUrl:       `${env.MOCK_BASE}/build/ssp.json`
  };
}

// ---------- WRITE: PR in DATA_REPO ------------------------------------------


async function writeTenantToRepo(env, orgId, tenantJson) {
  // Schreibt per GH API ins Data-Repo (branch, commit message etc.)
  const owner = env.DATA_OWNER;            // z.B. "open-gov-group"
  const repo  = env.DATA_REPO;             // z.B. "opengov-privacy-data"
  const path  = `data/tenants/${orgId}/tenant.json`;
  const msg   = `feat(tenant): add/update ${orgId}`;
  const token = env.GH_TOKEN_DATA;

  // 1) get current SHA (if exists), 2) put contents
  const contentB64 = btoa(unescape(encodeURIComponent(JSON.stringify(tenantJson, null, 2))));
  const getUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const putUrl = getUrl;

  let sha;
  const getR = await fetch(getUrl, { headers: { Authorization: `Bearer ${token}`, 'Accept': 'application/vnd.github+json' }});
  if (getR.ok) { const j = await getR.json(); sha = j.sha; }

  const putR = await fetch(putUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Accept': 'application/vnd.github+json' },
    body: JSON.stringify({ message: msg, content: contentB64, sha })
  });
  if (!putR.ok) throw new Error(`GH write failed: ${putR.status}`);
  return { path, rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${path}` };
}

export async function handlePostTenant(req, env) {
  const body = await req.json();
  const orgId = buildOrgId({
    euCode: body.euCode, stateCode: body.stateCode,
    countyCode: body.countyCode, townId: body.townId, townName: body.townName
  });

  const partyUuid = crypto.randomUUID();
  const tenantJson = {
    metadata: {
      title: `Tenant – ${body.townName}`,
      "last-modified": new Date().toISOString(),
      version: "0.1.0",
      "oscal-version": "1.1.2",
      roles: [
        { id: "controller", title: "Controller (Organisation)" },
        { id: "dpo", title: "Datenschutzbeauftragte:r" },
        { id: "ciso", title: "Informationssicherheitsbeauftragte:r" },
        { id: "po", title: "Product Owner / Fachverantwortung" }
      ],
      parties: [
        {
          uuid: partyUuid,
          type: "organization",
          name: `Stadt ${body.townName}`,
          "short-name": body.townName?.slice(0, 12) || "ORG",
          "external-ids": [{ scheme: "org-id:eu", id: orgId }],
          addresses: [{
            type: "work",
            "addr-lines": [ body.address?.line1 || "" ],
            city: body.address?.city || "",
            state: body.address?.state || "",
            "postal-code": body.address?.zip || "",
            country: body.address?.country || ""
          }],
          "email-addresses": body.email ? [body.email] : [],
          telephones: body.phone ? [{ type: "work", number: body.phone }] : [],
          links: body.website ? [{ href: body.website, rel: "website" }] : [],
          remarks: "Tenant master data for RoPA/SSP."
        }
      ],
      "responsible-parties": [
        { "role-id": "controller", "party-uuids": [ partyUuid ] }
      ]
    }
  };

  const res = await writeTenantToRepo(env, orgId, tenantJson);
    return ok(env, { ok: true, orgId, path: res.path, url: res.rawUrl });
}


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
  if (mk.status === 422) return newBranch; // already exists
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

// Schreibe mehrere Dateien in neuen Branch und öffne PR
async function writeFilesAsPR(env, branch, title, files, base = "main") {
  const okBranch = await ensureBranch(env, base, branch);
  if (!okBranch) return null;
  for (const f of files) {
    const contentObj = typeof f.content === 'string' ? JSON.parse(f.content) : f.content;
    const r = await putFile(env, branch, f.path, contentObj, `chore: add ${f.path}`);
    if (!r) return null;
  }
  const pr = await openPR(env, branch, title, `Automated update via API (${new Date().toISOString()})`, base);
  return pr?.html_url || null;
}

// Minimal JWT verify (HS256)
async function verifyJwtHS256(token, secret, { iss, aud } = {}) {
  try {
    const [h64, p64, s64] = token.split(".");
    if (!h64 || !p64 || !s64) return { ok: false, error: "malformed jwt" };

    const enc = str => new TextEncoder().encode(str);
    const b64u = s => s.replace(/-/g, "+").replace(/_/g, "/");
    const toArr = s => Uint8Array.from(atob(b64u(s)), c => c.charCodeAt(0));

    const data = `${h64}.${p64}`;
    const key = await crypto.subtle.importKey("raw", enc(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
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
  if (!env.APP_API_KEY) return { ok: false, error: "APP_API_KEY missing" };
  const iss = env.JWT_ISS || "open-privacy";
  const aud = env.JWT_AUD || "open-privacy-api";
  const res = await verifyJwtHS256(token, env.APP_API_KEY, { iss, aud });
  return res;
}

// Optional: simple SHA-256
async function sha256Hex(buf) {
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, "0")).join("");
}


async function handleInitTenant(env, orgId, payload) {
  // 1) einfache Validierung
  if (!/^[a-z0-9-]{2,64}$/.test(orgId)) {
    return json(env, 400, { error: 'invalid_orgId' });
  }

  const orgName = (payload?.orgName || '').trim();
  const defaultProfileHref = (payload?.defaultProfileHref || '').trim();
  const contactEmail = (payload?.contactEmail || '').trim();

  // 2) Minimaldaten
  const now = new Date().toISOString();
  const meta = {
    orgId, orgName, contactEmail,
    createdAt: now, updatedAt: now, version: '0.1.0'
  };

  // 3) Default-SSP anlegen (Template laden, Profil injizieren)
  const tpl = await buildSSPTemplate(env, defaultProfileHref || undefined); // deine neue async-Funktion
  const ssp = tpl; // bereits SSP-Objekt mit system-security-plan

  // 4) Zielpfade im Data-Repo
  const owner = env.DATA_OWNER;                // z.B. "open-gov-group"
  const repo  = env.DATA_REPO;                 // z.B. "opengov-privacy-data"
  const baseBranch = env.DATA_BASE || 'main';  // Branch (z.B. "main")
  const dataRoot   = 'data';                   // Root-Verzeichnis im Repo

  const bundleId = `bundle-1`;
  const orgDir   = `${dataRoot}/tenants/${orgId}`;
  const files = [
    { path: `${orgDir}/meta.json`, content: JSON.stringify(meta, null, 2) },
    ...(defaultProfileHref ? [{
      path: `${orgDir}/profiles/default.json`,
      content: JSON.stringify({ href: defaultProfileHref }, null, 2)
    }] : []),
    { path: `${orgDir}/bundles/${bundleId}/ssp.json`, content: JSON.stringify(ssp, null, 2) }
  ];

  // 5) Commit/PR ins Data-Repo
  const title = `feat(tenant): init ${orgId}`;
  const branch = `init/${orgId}-${Date.now()}`;
  const prUrl = await writeFilesAsPR(env, branch, title, files, baseBranch);

  // 6) Antwort
  return json(env, 200, {
    ok: true,
    orgId,
    created: { prUrl, branch },
    next: {
      // Direkt-RAW-URL zum ssp.json in der neuen Struktur (nach Merge aktualisieren)
      sspBundleHref: `https://raw.githubusercontent.com/${owner}/${repo}/refs/heads/${branch}/${orgDir}/bundles/${bundleId}/ssp.json`
    }
  });
}


// ------------------------------- ROUTER -------------------------------------

export default {
  async fetch(request, env) {
    try {
      // CORS preflight
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: makeCors(env) });
      }

      const url = new URL(request.url);
      const path = url.pathname;

      // basic
      if (path === "/healthz") return ok(env, { ok: true, ts: new Date().toISOString(), service: "open-privacy-api" });
      if (path === "/mode")   return ok(env, { mode: env.MODE || "mock" });

      // catalogs
      if (request.method === "GET" && path === "/api/catalogs") {
        const items = await listCatalogs(env);
        return ok(env, items, { "cache-control": "public, max-age=600, s-maxage=1800" });
      }

      // profiles
      if (request.method === "GET" && path === "/api/profiles") {
        const items = await listProfiles(env);
        return ok(env, items, { "cache-control": "public, max-age=600, s-maxage=1800" });
      }

      // profile-resolved
      if (request.method === "GET" && path === "/api/profile-resolved") {
        const href = url.searchParams.get("href") || env.DEFAULT_PROFILE_HREF;
        if (!href) return badReq(env, "missing href");
        const r = await resolveProfile(env, href);
        if (!r.ok) return notFound(env, `profile ${href}`);
        return ok(env, r.data, { "cache-control": "public, max-age=900, s-maxage=3600" });
      }

      // ssp template
      if (request.method === "GET" && path === "/api/templates/ssp") {
        const href = url.searchParams.get("profile") || env.DEFAULT_PROFILE_HREF || null;
        if (env.TEMPLATE_SSP_HREF) {
          const r = await fetchJson(env.TEMPLATE_SSP_HREF, { cf: { cacheTtl: 300, cacheEverything: true } });
          if (r.ok) return ok(env, r.data);
        }
        return ok(env, await buildSSPTemplate(env, href));
      }

      // fixtures
      if (request.method === "GET" && path === "/api/fixtures") {
        return ok(env, fixtures(env), { "cache-control": "public, max-age=300, s-maxage=900" });
      }

      // GET SSP
      let m = path.match(/^\/api\/ssp\/([^/]+)\/([^/]+)$/);
      if (request.method === "GET" && m) {
        const [_, org, proc] = m;
        const s = await getSSP(env, org, proc);
        if (!s.ok) return notFound(env, `ssp ${org}/${proc}`);
        return ok(env, s.data);
      }

      // GET SSP bundle
      m = path.match(/^\/api\/ssp-bundle\/([^/]+)\/([^/]+)$/);
      if (request.method === "GET" && m) {
        const [_, org, proc] = m;
        const s = await getSSP(env, org, proc);
        if (!s.ok) return notFound(env, `ssp ${org}/${proc}`);
        const p = await getProfileIfAny(s.data);
        return ok(env, { ssp: s.data, profile: p?.data || null });
      }

      // GET RoPA
      m = path.match(/^\/api\/ropa\/([^/]+)$/);
      if (request.method === "GET" && m) {
        const org = m[1];
        const r = await getRoPA(env, org);
        if (!r.ok) return notFound(env, `ropa ${org}`);
        return ok(env, r.data);
      }

      // POST /api/tenants  (einfaches Schreiben tenant.json in data/tenants/<orgId>)
      if (request.method === "POST" && path === "/api/tenants") {
        const key = request.headers.get('x-api-key');
        if (!key || key !== env.APP_API_KEY) return json(env, 401, { error: 'unauthorized' });
        return handlePostTenant(request, env);
      }

      // POST /api/tenants/:orgId/init  (Branch + Dateien + PR)
      m = path.match(/^\/api\/tenants\/([^/]+)\/init$/);
       if (request.method === "POST" && m) {
        const key = request.headers.get('x-api-key');
        if (!key || key !== env.APP_API_KEY) return json(env, 401, { error: 'unauthorized' });        
        const orgId = sanitizeId(m[1]);
        const payload = await request.json().catch(() => ({}));
        return handleInitTenant(env, orgId, payload);
      }

      const key = request.headers.get('x-api-key');
      if (!key || key !== env.APP_API_KEY) return json(env, 401, { error: 'unauthorized' });

      // POST SSP (PR to data repo)
      m = path.match(/^\/api\/ssp\/([^/]+)\/([^/]+)$/);
      if (request.method === "POST" && m) {
        const key = request.headers.get('x-api-key');
        if (!key || key !== env.APP_API_KEY) return json(env, 401, { error: 'unauthorized' });
        const gate = await requireJWT(request, env);
        if (!gate.ok) return unauthorized(env, gate.error);
        if (!env.GH_TOKEN_DATA) return serverErr(env, "GH_TOKEN_DATA not configured");

        const [_, org, proc] = m;
        let body;
        try { body = await request.json(); } catch { return badReq(env, "Body must be valid JSON"); }
        if (!body?.["system-security-plan"]) return badReq(env, "Missing 'system-security-plan' root");

        const branch = `update/${sanitizeId(org)}-${sanitizeId(proc)}-${nowStamp()}`;
        const okBranch = await ensureBranch(env, env.DATA_BASE || "main", branch);
        if (!okBranch) return serverErr(env, "Failed to create branch");

        const pathInRepo = `tenants/${sanitizeId(org)}/procedures/${sanitizeId(proc)}/ssp.json`;
        const msg = `chore(ssp): update ${org}/${proc} via API`;
        const put = await putFile(env, branch, pathInRepo, body, msg);
        if (!put) return serverErr(env, "Failed to write file");

        const title = `Update SSP: ${org}/${proc}`;
        const prBody = `Automated update via API (${new Date().toISOString()})`;
        const pr = await openPR(env, branch, title, prBody, env.DATA_BASE || "main");
        if (!pr) return serverErr(env, "Failed to open PR");

        return ok(env, { ok: true, pr_url: pr.html_url, branch, path: pathInRepo });
      }

      // POST evidence verify (HEAD + optional hash)
      if (request.method === "POST" && path === "/api/evidence/verify") {
        let body;
        try { body = await request.json(); } catch { return badReq(env, "Body must be JSON"); }
        const href = body?.href;
        if (!href) return badReq(env, "missing href");

        // HEAD für quick check
        let res = await fetchHead(href, { cf: { cacheTtl: 60, cacheEverything: false } });
        // Einige Server blocken HEAD → fallback GET (no-store)
        if (!res.ok || !res.headers.get("content-type")) {
          const got = await fetchArrayBuffer(href, { cf: { cacheTtl: 0, cacheEverything: false }, headers: { "cache-control": "no-cache" } });
          if (!got) return notFound(env, `evidence ${href}`);
          const ct = got.headers.get("content-type") || null;
          const out = { ok: true, status: 200, mediaType: ct };
          if (body?.wantHash === "sha256") {
            out.hash = await sha256Hex(got.buf);
            out.hashAlg = "sha256";
          }
          return ok(env, out, { "cache-control": "no-store" });
        }
        const ct = res.headers.get("content-type") || null;
        return ok(env, { ok: true, status: res.status, mediaType: ct }, { "cache-control": "public, max-age=60" });
      }

      // root / help
      if (path === "/") {
        return ok(env, {
          name: "open-privacy-api",
          mode: env.MODE || "mock",
          endpoints: [
            "GET  /healthz",
            "GET  /mode",
            "GET  /api/catalogs",
            "GET  /api/profiles",
            "GET  /api/profile-resolved?href=<url>",
            "GET  /api/templates/ssp",
            "GET  /api/fixtures",
            "GET  /api/ssp/:org/:proc",
            "GET  /api/ssp-bundle/:org/:proc",
            "GET  /api/ropa/:org",
            "POST /api/tenants",
            "POST /api/tenants/:orgId/init",
            "POST /api/ssp/:org/:proc",
            "POST /api/evidence/verify"
          ],
          example: {
            profiles: "/api/profiles",
            profileResolved: "/api/profile-resolved?href=https%3A%2F%2Fraw.githubusercontent.com%2Fopen-gov-group%2Fopengov-privacy-oscal%2Fmain%2Foscal%2Fprofiles%2Fprofile_intervenability.json",
            template: "/api/templates/ssp?profile=<profile-href>",
            sspBundle: "/api/ssp-bundle/demo-org/emr-auskunft"
          }
        });
      }

      if (path === "/help") {
        return ok(env, {
          mockBase: env.MOCK_BASE,
          expects: `${env.MOCK_BASE}/build/<proc>.json`,
          tip: "Nutze einen <proc>-Namen, der zu einer existierenden Datei im build/-Ordner passt."
        });
      }

      return new Response("Not found", { status: 404, headers: makeCors(env) });
    } catch (e) {
      return serverErr(env, String(e?.message || e));
    }
  }
};
