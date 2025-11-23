// workers/libs/tenantProcedures.mjs
import { ensureBranch } from './tenant.mjs';

const RAW = (owner, repo, branch, path) =>
  `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;

const API_CONTENTS = (owner, repo, path) =>
  `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;

async function ghReadJson(env, path) {
  const url = RAW(env.DATA_OWNER, env.DATA_REPO, env.DATA_BASE || 'main', path);
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) return null;
  return await res.json();
}

async function ghList(env, dirPath, ref) {
  const branch = ref || env.DATA_BASE || 'main';
  const url = `https://api.github.com/repos/${env.DATA_OWNER}/${env.DATA_REPO}/contents/${dirPath}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/vnd.github+json' } });
  if (!res.ok) return [];
  const items = await res.json();
  return Array.isArray(items)
    ? items.filter(x => x.type === 'dir').map(x => x.name)
    : [];
}


async function ghGetSha(env, path, ref) {
  const url = `${API_CONTENTS(env.DATA_OWNER, env.DATA_REPO, path)}?ref=${ref}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/vnd.github+json' } });
  if (!res.ok) return null;
  const meta = await res.json();
  return meta && meta.sha || null;
}

function ghHeaders(env, extra = {}) {
  return {
    // gleiches Muster wie in tenant.mjs
    authorization: `Bearer ${env.GH_TOKEN_DATA}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'opengov-privacy-api/1.0',
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
    ...extra
  };
}


async function ghPutFile(env, branch, path, contentJson, message) {
  const body = {
    message,
    content: btoa(unescape(encodeURIComponent(JSON.stringify(contentJson, null, 2)))),
    branch
  };
  // sha, wenn Datei schon existiert
  const existingSha = await ghGetSha(env, path, branch);
  if (existingSha) body.sha = existingSha;

  const res = await fetch(API_CONTENTS(env.DATA_OWNER, env.DATA_REPO, path), {
    method: 'PUT',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.GH_TOKEN_DATA}`
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text().catch(()=> '');
    return { ok:false, status: res.status, error: t || 'write_failed' };
  }
  return { ok:true };
}

async function ghOpenPr(env, branch, title) {
  const prUrl = `https://api.github.com/repos/${env.DATA_OWNER}/${env.DATA_REPO}/pulls`;
  const res = await fetch(prUrl, {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.GH_TOKEN_DATA}`
    },
    body: JSON.stringify({
      title,
      head: branch,
      base: env.DATA_BASE || 'main'
    })
  });
  if (!res.ok) return null;
  const pr = await res.json();
  return pr && pr.html_url || null;
}

const sspPath = (orgId, sspId) =>
  `data/tenants/${orgId}/procedures/${sspId}/ssp.json`;


export async function listSSPs(env, orgId, ref) {
  return await ghList(env, `data/tenants/${orgId}/procedures`, ref);
}

export async function readSSP(env, orgId, sspId) {
  return await ghReadJson(env, sspPath(orgId, sspId));
}

export async function writeSSP(env, orgId, sspId, doc) {
  const base = env.DATA_BASE || 'main';
  const branchRaw = `procedure/${orgId}/${sspId}/${Date.now()}`;

  const mk = await ensureBranch(env, base, branchRaw);
  if (!mk?.ok) return { ok:false, error: mk.error || 'branch_failed', detail: mk.detail };

  const branch = mk.branch || branchRaw;

  const path = sspPath(orgId, sspId);
  const put = await ghPutFile(env, branch, path, doc, `feat(procedure): ${orgId}/${sspId} update SSP`);

  if (!put.ok) return put;

  const prUrl = await ghOpenPr(env, branch, `[SSP] ${orgId}/${sspId}`);
  return { ok:true, branch, prUrl };
}

// libs/tenantProcedures.mjs
// putTenantBundle: mehrere Dateien (JSON) in einen Tenant/Prozess-Ordner schreiben (Contents API)


// Hilfsfunktion: einzelne JSON-Datei via Contents API schreiben
async function putJsonContent(env, branch, repoPath, obj, message) {
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(obj, null, 2))));
  const getUrl = `https://api.github.com/repos/${env.DATA_OWNER}/${env.DATA_REPO}/contents/${encodeURIComponent(repoPath)}?ref=${encodeURIComponent(branch)}`;
  let sha = undefined;
  const getResp = await fetch(getUrl, { headers: ghHeaders(env) });
  if (getResp.ok) {
    const j = await getResp.json();
    sha = j.sha;
  }

  const putUrl = `https://api.github.com/repos/${env.DATA_OWNER}/${env.DATA_REPO}/contents/${encodeURIComponent(repoPath)}`;
  const body = {
    message,
    content,
    branch,
    ...(sha ? { sha } : {})
  };
  const resp = await fetch(putUrl, { method: 'PUT', headers: ghHeaders(env), body: JSON.stringify(body) });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    return { ok: false, status: resp.status, error: text || 'github_put_failed' };
  }
  return { ok: true };
}

/**
 * putTenantBundle
 * @param {Env} env - Worker env (GH_TOKEN_DATA, DATA_OWNER, DATA_REPO…)
 * @param {string} orgId - Tenant-OrgID
 * @param {string} procId - Prozess-ID (z. B. 'proc-1')
 * @param {Array<{ path: string, content: any }>} files - zu schreibende Dateien relativ zum Tenant-Root
 * @param {string} branch - Ziel-Branch
 * @param {string} commitPrefix - optionaler Prefix für Commit-Nachrichten
 */
/**
 * High-Level putTenantBundle
 * Wird so von importXdomeaIntoTenant aufgerufen:
 *   putTenantBundle(env, orgId, bundleId, { title, slug, profileHref, ssp })
 */
export async function putTenantBundle(env, orgId, procId, bundle, options = {}) {
  const base = env.DATA_BASE || 'main';
  const branchRaw = (options.ref && options.ref.trim())
    ? options.ref.trim()
    : `bundle/${orgId}/${procId}/${Date.now()}`;
  const commitPrefix = options.commitPrefix || 'feat(bundle)';

  // 1) Branch mit ensureBranch anlegen (robust, mit Auth etc.)
  const mk = await ensureBranch(env, base, branchRaw);
  if (!mk?.ok) {
    return {
      ok: false,
      error: 'branch_failed',
      detail: mk
    };
  }
  const branch = mk.branch || branchRaw;

  // 2) Dateien definieren
  const root = `data/tenants/${orgId}/procedures/${procId}`;
  const files = [
    { path: 'ssp.json', content: bundle.ssp },
    {
      path: 'bundle.json',
      content: {
        title: bundle.title,
        slug: bundle.slug,
        profileHref: bundle.profileHref || null
      }
    }
  ];

  // 3) Dateien schreiben
  for (const f of files) {
    const fullPath = `${root}/${f.path}`.replace(/\/+/g, '/');
    const result = await putJsonContent(
      env,
      branch,
      fullPath,
      f.content,
      `${commitPrefix}: write ${fullPath}`
    );
    if (!result.ok) {
      return {
        ok: false,
        error: 'write_failed',
        detail: result.error || result.status || fullPath
      };
    }
  }

  // 4) PR öffnen
  const prUrl = await ghOpenPr(env, branch, `[BUNDLE] ${orgId}/${procId}`);

  // 5) SSP-API-Href zurückgeben
  const sspHref = `/api/tenants/${encodeURIComponent(orgId)}/procedures/${encodeURIComponent(procId)}`;

  return { ok: true, sspHref, prUrl };
}
