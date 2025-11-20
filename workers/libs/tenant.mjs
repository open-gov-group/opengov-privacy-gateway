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

/** GitHub API Helfer (Contents + Refs + PR) */
async function ghGet(env, url) {
  const r = await fetch(url, { headers: { authorization: `Bearer ${env.GH_TOKEN_DATA}`, accept: "application/vnd.github+json" }});
  return r;
}
async function ghJson(env, url, init = {}) {
  const r = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${env.GH_TOKEN_DATA}`, accept: "application/vnd.github+json", "content-type":"application/json", ...(init.headers||{}) }
  });
  return r;
}
async function ensureBranch(env, base, newBranch) {
  const ref = await ghGet(env, `https://api.github.com/repos/${env.DATA_OWNER}/${env.DATA_REPO}/git/ref/heads/${base}`);
  //const ref = await ghGet(env, `https://api.github.com/repos/${env.DATA_OWNER}/${env.DATA_REPO}/git/ref/heads/main`);
  if (!ref.ok) return null;
  const j = await ref.json();
  const mk = await ghJson(env, `https://api.github.com/repos/${env.DATA_OWNER}/${env.DATA_REPO}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${newBranch}`, sha: j.object.sha })
  });
  if (mk.status === 422) return newBranch; // existiert bereits
  return mk.ok ? newBranch : null;
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
async function openPR(env, branch, title, body, base = "main") {
  const resp = await ghJson(env, `https://api.github.com/repos/${env.DATA_OWNER}/${env.DATA_REPO}/pulls`, {
    method: "POST",
    body: JSON.stringify({ title, head: branch, base, body })
  });
  return resp.ok ? await resp.json() : null;
}

/** Raw JSON holen (read) */
async function fetchRawJson(owner, repo, ref, path) {
  const u = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
  const r = await fetch(u, { cf: { cacheEverything: true, cacheTtl: 300 }});
  if (!r.ok) return { ok:false, status:r.status };
  return { ok:true, status:r.status, data: await r.json() };
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
export async function readTenantJson(env, orgId) {
  const p = tenantPaths(orgId);
  return await fetchRawJson(env.DATA_OWNER, env.DATA_REPO, env.DATA_BASE || "main", p.meta);
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

  const branch = `init/${id}-${nowStamp()}`;
  const okBr = await ensureBranch(env, env.DATA_BASE || "main", branch);
  if (!okBr) return { ok:false, error:"branch_failed - "+ "env: "+ env.DATA_REPO + " base: " + env.DATA_BASE + "branch: " + branch};

  const files = [
    { path: p.meta, content: meta },
    ...(payload.defaultProfileHref ? [{ path: p.defaultProfile, content: { href: payload.defaultProfileHref } }] : []),
    { path: p.ssp, content: sspRoot }
  ];
  for (const f of files) {
    const wr = await putJsonFile(env, branch, f.path, f.content, `chore(tenant): add ${f.path}`);
    if (!wr) return { ok:false, error:`write_failed:${f.path}` };
  }
  const pr = await openPR(env, branch, `feat(tenant): init ${id}`, `Automated init at ${now}`, env.DATA_BASE || "main");
  return {
    ok: true,
    branch,
    prUrl: pr?.html_url || null,
    next: { sspBundleHref: `https://raw.githubusercontent.com/${env.DATA_OWNER}/${env.DATA_REPO}/refs/heads/${branch}/${p.ssp}` }
  };
}

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
  const okBr = await ensureBranch(env, env.DATA_BASE || "main", branch);
  if (!okBr) return { ok:false, error:"branch_failed" };

  const okDel = await deleteFile(env, branch, p.meta, `chore(tenant): delete ${p.meta}`);
  if (!okDel) return { ok:false, error:"delete_failed" };

  const pr = await openPR(env, branch, `chore(tenant): delete meta of ${id}`, `Automated delete`, env.DATA_BASE || "main");
  return { ok:true, branch, prUrl: pr?.html_url || null };
}
