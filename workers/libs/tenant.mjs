// workers/lib/tenant.mjs

/**
 * @typedef {Object} TenantInitPayload
 * @property {string} orgName
 * @property {string} [contactEmail]
 * @property {string} [defaultProfileHref]
 * @property {{line1?:string, city?:string, state?:string, zip?:string, country?:string}} [address]
 * @property {string} [phone]
 * @property {string} [website]
 */

/**
 * @typedef {Object} GHWriteResult
 * @property {string} path
 * @property {string} rawUrl
 */

/** Kleine Utils */
//const enc = (s) => new TextEncoder().encode(s);
const toB64 = (o) => {
  const json = typeof o === "string" ? o : JSON.stringify(o, null, 2);
  return btoa(unescape(encodeURIComponent(json)));
};
const sanitizeId = (s) => String(s || "").trim().replace(/[^a-zA-Z0-9._-]/g, "");
const nowStamp = () => new Date().toISOString().replace(/[:.]/g, "-");

// --- GitHub helpers (robust) ---
function ghRawBase(owner, repo, branch) {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}`;
}
function tenantRoot(owner, repo, branch, orgId) {
  // our repo layout: data/tenants/<orgId>/...
  return `${ghRawBase(owner, repo, branch)}/data/tenants/${encodeURIComponent(orgId)}`;
}
function sspHref(owner, repo, branch, orgId, procId = 'proc-1') {
  return `${tenantRoot(owner, repo, branch, orgId)}/procedures/${encodeURIComponent(procId)}/ssp.json`;
}

function rawSspHref(owner, repo, branch, orgId, procId='proc-1') {
  // Branch NICHT mit encodeURIComponent behandeln (oder danach %2F → / zurückdrehen)
  const safeBranch = String(branch).replace(/%2F/gi, '/');
  return `https://raw.githubusercontent.com/${owner}/${repo}/${safeBranch}/data/tenants/${orgId}/procedures/${procId}/ssp.json`;
}

function ghHeaders(env, extra={}) {
  return {
    // Fine-grained PATs work with either "token" or "Bearer"
    authorization: `Bearer ${env.GH_TOKEN_DATA}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'opengov-privacy-api/1.0',
    'x-github-api-version': '2022-11-28',
    ...extra
  };
}

async function ghGet(env, url) {
  return fetch(url, { headers: ghHeaders(env) });
}

async function ghJson(env, url, init={}) {
  const headers = ghHeaders(env, init.headers || {});
  return fetch(url, { ...init, headers });
}

// defensively normalize the base branch (avoid URLs accidentally set into DATA_BASE)
function normalizeBaseBranch(env) {
  const raw = (env.DATA_BASE || 'main').trim();
  return /^https?:\/\//i.test(raw) ? 'main' : raw;
}

// sanitize/validate new branch names (no :, ?, [, ], etc.)
function safeBranchName(s) {
  // forbid characters per Git rules: ~ ^ : ? * [ space at end, etc.
  return s.replace(/[:?*\[\\\]^~\s]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

async function getBaseRef(env, owner, repo, base) {
  // Try singular endpoint first (documented), then plural fallback (some proxies/extensions expect it)
  let r = await ghGet(env, `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${base}`);
  if (r.status === 404) {
    r = await ghGet(env, `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${base}`);
  }
  return r;
}

async function ensureBranch(env, baseRaw, newBranchRaw) {
  const owner = env.DATA_OWNER;
  const repo  = env.DATA_REPO;
  const base  = normalizeBaseBranch(env);
  const newBranch = safeBranchName(newBranchRaw);

  // 1) resolve base ref sha
  const ref = await getBaseRef(env, owner, repo, base);
  if (!ref.ok) {
    const body = await ref.text().catch(()=> '');
    // Surface the server reason so you see what failed in CF logs
    return { ok:false, error:'base_ref_failed', status: ref.status, detail: body };
  }
  const j = await ref.json();

  const sha = j?.object?.sha;
  if (!sha) {
    return { ok:false, error:'no_base_sha', detail: JSON.stringify(j).slice(0,500) };
  }

  // 2) create new ref
  const mk = await ghJson(env, `https://api.github.com/repos/${owner}/${repo}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${newBranch}`, sha })
  });

  if (mk.ok) {
    return { ok:true, branch:newBranch };
  }

  // 3) handle 422 specifically: might be "Reference already exists" OR a validation error
  if (mk.status === 422) {
    const msg = await mk.json().catch(async()=> ({ message: await mk.text().catch(()=> '') }));
    const message = (msg && (msg.message || msg.error || '')).toString();
    if (/already exists/i.test(message)) {
      return { ok:true, branch:newBranch, exists:true };
    }
    return { ok:false, error:'create_ref_422', detail: message };
  }

  const fallback = await mk.text().catch(()=> '');
  return { ok:false, error:'create_ref_failed', status: mk.status, detail: fallback };
}


async function putJsonFile(env, branch, pathInRepo, contentObj, message) {
  const get = await ghGet(env, `https://api.github.com/repos/${env.DATA_OWNER}/${env.DATA_REPO}/contents/${encodeURIComponent(pathInRepo)}?ref=${encodeURIComponent(branch)}`);
  let sha = undefined;
  if (get.ok) { const g = await get.json(); sha = g?.sha; }
  const put = await ghJson(env, `https://api.github.com/repos/${env.DATA_OWNER}/${env.DATA_REPO}/contents/${encodeURIComponent(pathInRepo)}`, {
    method: "PUT",
    body: JSON.stringify({ message, content: toB64(contentObj), branch, sha })
  });
  if (!put.ok) return null;
  return await put.json();
}
async function deleteFile(env, branch, pathInRepo, message) {
  const get = await ghGet(env, `https://api.github.com/repos/${env.DATA_OWNER}/${env.DATA_REPO}/contents/${encodeURIComponent(pathInRepo)}?ref=${encodeURIComponent(branch)}`);
  if (!get.ok) return null;
  const g = await get.json();
  const del = await ghJson(env, `https://api.github.com/repos/${env.DATA_OWNER}/${env.DATA_REPO}/contents/${encodeURIComponent(pathInRepo)}`, {
    method: "DELETE",
    body: JSON.stringify({ message, sha: g.sha, branch })
  });
  return del.ok;
}

// Find an open PR for a given branch `head = owner:branch`
async function findOpenPR(env, branch) {
  // Fine-grained tokens require "Pull requests: Read" here.
  const owner = env.DATA_OWNER;
  const repo  = env.DATA_REPO;
  const url   = `https://api.github.com/repos/${owner}/${repo}/pulls`
              + `?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`;

  const resp = await ghJson(env, url, { method: "GET" });
  if (!resp.ok) return null;

  const arr = await resp.json();
  return Array.isArray(arr) && arr.length ? arr[0] : null;
}


async function openPR(env, head, title, body, base) {
  const resp = await ghJson(env, `https://api.github.com/repos/${env.DATA_OWNER}/${env.DATA_REPO}/pulls`, {
    method: "POST",
    body: JSON.stringify({ title, head: head, base, body })
  });
  return resp.ok ? await resp.json() : null;
}

async function mergePR(env, number) {
  //const u = `${GH_ROOT}/repos/${env.DATA_OWNER}/${env.DATA_REPO}/pulls/${number}/merge`;
  const u = `https://api.github.com/repos/${env.DATA_OWNER}/${env.DATA_REPO}/pulls/${number}/merge`;
  const r = await ghJson(env, u, { method: "PUT", body: JSON.stringify({ merge_method: "squash" }) });
  if (r.status === 405) return { ok: false, alreadyMerged: true }; // schon gemerged
  return r.ok ? await r.json() : null;
}

/** Raw JSON holen (read) */
async function fetchRawJson(owner, repo, ref, path) {
  const u = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
  const r = await fetch(u, { cf: { cacheEverything: true, cacheTtl: 300 }});
  if (!r.ok) return { ok:false, status:r.status };
  return { ok:true, status:r.status, data: await r.json() };
}


/**
 * Entwurf speichern: tenant.json auf Branch schreiben, PR anlegen (falls keiner offen).
 * @returns {Promise<{ok:boolean, branch:string, commit?:string, prUrl?:string}>}
 */
export async function saveTenantDraft(env, orgId, tenantJson, ref) {
  const base = env.DATA_BASE || "main";
  const branch = ref && ref.trim() ? ref.trim() : `feature/${orgId}-tenant`;
  const okBr = await ensureBranch(env, base, branch);
  if (!okBr) return { ok: false, error: "branch_failed" };

  // Pfade
  const pathTenant = `data/tenants/${orgId}/tenant.json`;
  const metaPath   = `data/tenants/${orgId}/meta.json`;

  const meta = {
    orgId,
    updatedAt: new Date().toISOString(),
    profileHref: tenantJson?.profileHref || env.DEFAULT_PROFILE_HREF || null,
  };

  const w1 = await putJsonFile(env, branch, metaPath, meta, `chore(tenant): update ${orgId} meta`);
  if (!w1) return { ok:false, error:`write_failed:${metaPath}` };

  const w2 = await putJsonFile(env, branch, pathTenant, tenantJson, `chore(tenant): update ${orgId} tenant`);
  if (!w2) return { ok:false, error:`write_failed:${pathTenant}` };

  // PR finden/erzeugen
  //const existing = await findOpenPR(env, branch, base);
  //const pr = existing || (await openPR(env, branch, base, `feat(tenant): ${orgId}`, `Automated update ${new Date().toISOString()}`));
  const existing = await findOpenPR(env, branch); // base wird hier nicht benötigt
  const pr = existing || (await openPR(
    env,
    branch,                                  // head (owner:branch wird in openPR zusammengesetzt)
    `feat(tenant): ${orgId}`,                // title
    `Automated update ${new Date().toISOString()}`, // body
    base                                     // base branch
  ));
  return {
    ok: true,
    branch,
    commit: w2.commit?.sha,
    prUrl: pr?.html_url,
  };
}

/**
 * Merge: PR für head→base finden (oder anlegen) und mergen.
 * @returns {Promise<{ok:boolean, merged?:boolean, base:string, head:string, mergeSha?:string, prUrl?:string}>}
 */
export async function mergeTenantBranch(env, { head, base}) {
  if (!head) return { ok:false, error:"missing_head" };

  let pr = await findOpenPR(env, head, base);
  if (!pr) {
    pr = await openPR(env, head, base, `feat(tenant): merge ${head}`, `Automated merge request ${new Date().toISOString()}`);
    if (!pr) return { ok:false, error:"open_pr_failed" };
  }
  const merged = await mergePR(env, pr.number);
  if (merged && merged.merged) {
    return { ok:true, merged:true, base, head, mergeSha: merged.sha, prUrl: pr.html_url };
  }
  if (merged?.alreadyMerged) {
    return { ok:true, merged:true, base, head, prUrl: pr.html_url };
  }
  return { ok:false, error:"merge_failed", base, head, prUrl: pr?.html_url };
}


/** SSP-Template laden (OSCAL Repo) und minimal vollständig machen */
export async function buildTenantSsp(env, profileHref) {
  const candidates = [];
  if (env.TEMPLATE_SSP_HREF) candidates.push(env.TEMPLATE_SSP_HREF);
  candidates.push("https://raw.githubusercontent.com/open-gov-group/opengov-privacy-oscal/main/oscal/ssp/ssp_template_ropa.json");

  for (const href of candidates) {
    try {
      const r = await fetch(href, { cf: { cacheEverything:true, cacheTtl:300 } });
      if (!r.ok) continue;
      /** @type {any} */
      const tpl = await r.json();
      const root = tpl && tpl["system-security-plan"] ? tpl : null;
      if (!root) continue;

      const ssp = root["system-security-plan"];
      if (profileHref && !ssp["import-profile"]) ssp["import-profile"] = { href: profileHref };
      ssp.uuid = ssp.uuid || crypto.randomUUID();
      ssp.metadata = ssp.metadata || {};
      ssp.metadata["oscal-version"] = ssp.metadata["oscal-version"] || "1.1.2";
      ssp.metadata["last-modified"] = ssp.metadata["last-modified"] || new Date().toISOString();
      ssp["system-characteristics"] = ssp["system-characteristics"] || {
        "system-ids": [{ "identifier-type": "https://ietf.org/rfc/rfc4122", id: `urn:uuid:${crypto.randomUUID()}` }],
        "system-name": "Processing activity – <Title>",
        "system-name-short": "PA-<Short>",
        description: "Short description of the processing.",
        status: { state: "operational" },
        "security-sensitivity-level": "moderate",
        "system-information": { "information-types": [{ title: "Personal data (GDPR)", description: "Typical RoPA categories." }] },
        props: [
          { name: "ropa:purpose", value: "<purpose(s)>" },
          { name: "ropa:data-categories", value: "<categories>" },
          { name: "ropa:data-subjects", value: "<subjects>" },
          { name: "ropa:recipients", value: "<recipients>" },
          { name: "ropa:third-country-transfers", value: "<No/Yes – legal basis>" },
          { name: "ropa:retention", value: "<retention>" },
          { name: "ropa:legal-basis", value: "<Art. 6 GDPR / sector law>" }
        ],
        "authorization-boundary": { description: "Scope of the processing environment." }
      };
      ssp["system-implementation"] = ssp["system-implementation"] || { users: [], components: [] };
      ssp["control-implementation"] = ssp["control-implementation"] || { description: "Implementation per profile/catalog.", "implemented-requirements": [] };
      ssp["back-matter"] = ssp["back-matter"] || { resources: [] };
      return root;
    } catch {}
  }

  // Rückfall (robust)
  return {
    "system-security-plan": {
      uuid: crypto.randomUUID(),
      metadata: { title: "SSP (RoPA) – Template", "last-modified": new Date().toISOString(), version: "0.2.0", "oscal-version": "1.1.2" },
      ...(profileHref ? { "import-profile": { href: profileHref } } : {}),
      "system-characteristics": {
        "system-ids": [{ "identifier-type": "https://ietf.org/rfc/rfc4122", id: `urn:uuid:${crypto.randomUUID()}` }],
        "system-name": "Processing activity – <Title>",
        "system-name-short": "PA-<Short>",
        description: "Short description",
        status: { state: "operational" },
        "security-sensitivity-level": "moderate",
        "system-information": { "information-types": [{ title: "Personal data (GDPR)", description: "Typical RoPA categories." }] },
        props: [
          { name: "ropa:purpose", value: "<purpose(s)>" },
          { name: "ropa:data-categories", value: "<categories>" },
          { name: "ropa:data-subjects", value: "<subjects>" },
          { name: "ropa:recipients", value: "<recipients>" },
          { name: "ropa:third-country-transfers", value: "<No/Yes – legal basis>" },
          { name: "ropa:retention", value: "<retention>" },
          { name: "ropa:legal-basis", value: "<Art. 6 GDPR / sector law>" }
        ],
        "authorization-boundary": { description: "Scope." }
      },
      "system-implementation": { users: [], components: [] },
      "control-implementation": { description: "Implementation per profile/catalog.", "implemented-requirements": [] },
      "back-matter": { resources: [] }
    }
  };
}

/** Pfade im Data-Repo */
function tenantPaths(orgId) {
  const root = `data/tenants/${orgId}`;
  return {
    root,
    meta: `${root}/meta.json`,
    // tenant-Hauptakte
    tenant: `${root}/tenant.json`,
    // Profile: resolved + default-Pointer
    profileDefault: `${root}/profiles/default.json`,
    profileResolvedDir: `${root}/profiles/resolved`,
    // RoPA
    ropaIndex: `${root}/ropa/index.json`,
    ropa: `${root}/ropa/ropa.json`,
    // Verfahren (SSP) – erstes Verfahren/Bundle optional „proc-1“
    proceduresDir: `${root}/procedures`,
    ssp(procId = 'proc-1') { return `${root}/procedures/${procId}/ssp.json`; },
    poam(procId = 'proc-1') { return `${root}/procedures/${procId}/poam.json`; },
    assessmentPlan(procId = 'proc-1') { return `${root}/procedures/${procId}/assessment/plan.json`; },
    assessmentResult(procId = 'proc-1') { return `${root}/procedures/${procId}/assessment/result.json`; },
    evidenceRegistry(procId = 'proc-1') { return `${root}/procedures/${procId}/evidence/registry.json`; }
  };
}


/** Existiert die Org im Data-Repo? (meta.json) */
export async function checkDataIfOrgIdExists(env, orgId) {
  const p = tenantPaths(orgId);
  const r = await ghGet(env, `https://api.github.com/repos/${env.DATA_OWNER}/${env.DATA_REPO}/contents/${encodeURIComponent(p.meta)}?ref=${encodeURIComponent(env.DATA_BASE || "main")}`);
  return r.ok;
}

/** Tenant lesen (meta.json) */
export async function readTenantMetaJson(env, orgId) {
  const p = tenantPaths(orgId);
  return await fetchRawJson(env.DATA_OWNER, env.DATA_REPO, env.DATA_BASE || "main", p.meta);
}

/** Tenant lesen (meta.json) */
export async function readTenantJson(env, orgId) {
  const p = tenantPaths(orgId);
  return await fetchRawJson(env.DATA_OWNER, env.DATA_REPO, env.DATA_BASE || "main", p.tenant);
}

/** Tenant initialisieren (Branch + Dateien + PR) */
export async function initTenant(env, orgId, /** @type {TenantInitPayload} */ payload) {
  const id = sanitizeId(orgId);
  const now = new Date().toISOString();
  const meta = {
    orgId: id,
    orgName: String(payload.orgName||"").trim(),
    contactEmail: String(payload.contactEmail||"").trim(),
    createdAt: now,
    updatedAt: now,
    version: "0.1.0"
  };
  //const sspRoot = await buildTenantSsp(env, (payload.defaultProfileHref||"").trim() || undefined);
  const prof = payload.defaultProfileHref?.trim();
  const sspRoot = await buildTenantSsp(env, prof || undefined);
  const p = tenantPaths(id);
  const base = normalizeBaseBranch(env);
  const branch = `init/${id}-${nowStamp()}`;

  //if (!okBr) return { ok:false, error:"branch_failed - "+ "env: "+ env.DATA_REPO + " base: " + base + " branch: " + branch};
  const mk = await ensureBranch(env, base, branch);
    if (!mk?.ok) {
      return { ok:false, error:"branch_failed", detail: mk };
    }
  const branchName = mk.branch;

  const files = [
    { path: p.meta, content: meta },
    ...(payload.defaultProfileHref ? [{ path: p.defaultProfile, content: { href: payload.defaultProfileHref } }] : []),
    { path: p.ssp, content: sspRoot }
  ];
for (const f of files) {
  const wr = await putJsonFile(env, branchName, f.path, f.content, `chore(tenant): add ${f.path}`);
  if (!wr) return { ok:false, error:`write_failed:${f.path}` };
}
const pr = await openPR(env, branchName, `feat(tenant): init ${id}`, `Automated init at ${now}`, env.DATA_BASE || "main");

//  return {
//    ok: true,
//    branch,
//    prUrl: pr?.html_url || null,
//    next: { sspBundleHref: rawSspHref(env.DATA_OWNER, env.DATA_REPO, branchName, id, 'proc-1') }
//  };
    return {
    ok: true,
    branch: branchName,
    prUrl: pr?.html_url || null,
    next: { sspBundleHref: rawSspHref(env.DATA_OWNER, env.DATA_REPO, branchName, id, 'proc-1') }
  };
}
// old call
//next: { sspBundleHref: `https://raw.githubusercontent.com/${env.DATA_OWNER}/${env.DATA_REPO}/refs/heads/${branch}/${p.ssp}` }

/** Tenant aktualisieren (direkt Commit oder ebenfalls via PR – hier PR) */
export async function updateTenant(env, orgId, tenantMetaJson) {
  const id = sanitizeId(orgId);
  const p = tenantPaths(id);
  const branch = `update/${id}-${nowStamp()}`;
  const okBr = await ensureBranch(env, env.DATA_BASE || "main", branch);
  if (!okBr) return { ok:false, error:"branch_failed" };

  const meta = { ...(tenantMetaJson||{}), orgId:id, updatedAt:new Date().toISOString() };
  const wr = await putJsonFile(env, branch, p.meta, meta, `chore(tenant): update ${p.meta}`);
  if (!wr) return { ok:false, error:"write_failed" };

  const pr = await openPR(env, branch, `chore(tenant): update ${id}`, `Automated update`, env.DATA_BASE || "main");
  return { ok:true, branch, prUrl: pr?.html_url || null, metaPath: p.meta };
}

/** Tenant löschen (Beispiel: nur meta.json löschen – volle Ordner-Löschung wäre mehr Logik) */
export async function deleteTenant(env, orgId) {
  const id = sanitizeId(orgId);
  const p = tenantPaths(id);
  const branch = `delete/${id}-${nowStamp()}`;
  //const okBr = await ensureBranch(env, env.DATA_BASE || "main", branch);
  //if (!okBr) return { ok:false, error:"branch_failed" };
  const mk = await ensureBranch(env, base, branch);
  if (!mk?.ok) return { ok:false, error:"branch_failed", detail: mk };
  const branchName = mk.branch;
  const okDel = await deleteFile(env, branchName, p.meta, `chore(tenant): delete ${p.meta}`);
  if (!okDel) return { ok:false, error:"delete_failed" };

  const pr = await openPR(env, branch, `chore(tenant): delete meta of ${id}`, `Automated delete`, env.DATA_BASE || "main");
  return { ok:true, branch, prUrl: pr?.html_url || null };
}
