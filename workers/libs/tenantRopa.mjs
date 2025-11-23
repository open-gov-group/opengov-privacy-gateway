// workers/libs/tenantRopa.mjs

import { ingestXdomea } from './mapping.mjs';
import { buildMinimalSSP } from './oscal.mjs';
import { putTenantBundle, ghReadJson } from './tenantProcedures.mjs';
import { ensureBranch, putJsonFile } from './tenant.mjs';

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
async function ghList(env, dirPath) {
  const url = `https://api.github.com/repos/${env.DATA_OWNER}/${env.DATA_REPO}/contents/${dirPath}?ref=${env.DATA_BASE || 'main'}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/vnd.github+json' } });
  if (!res.ok) return [];
  const items = await res.json();
  return Array.isArray(items) ? items.filter(x => x.type === 'file' && x.name.endsWith('.json')).map(x => x.name.replace(/\.json$/,'')) : [];
}
async function ghGetSha(env, path, ref) {
  const url = `${API_CONTENTS(env.DATA_OWNER, env.DATA_REPO, path)}?ref=${ref}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/vnd.github+json' } });
  if (!res.ok) return null;
  const meta = await res.json();
  return meta && meta.sha || null;
}
async function ghEnsureBranch(env, base, branch) {
  const refUrl = `https://api.github.com/repos/${env.DATA_OWNER}/${env.DATA_REPO}/git/ref/heads/${base}`;
  const refRes = await fetch(refUrl, { headers: { 'Accept': 'application/vnd.github+json' } });
  if (!refRes.ok) return { ok:false, error: 'base_ref_not_found' };
  const ref = await refRes.json();
  const sha = ref.object && ref.object.sha;

  const createUrl = `https://api.github.com/repos/${env.DATA_OWNER}/${env.DATA_REPO}/git/refs`;
  const createRes = await fetch(createUrl, {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.GH_TOKEN_DATA}`
    },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha })
  });
  if (createRes.status === 422) return { ok:true };
  if (!createRes.ok) return { ok:false, error: await createRes.text().catch(()=> 'create_branch_failed') };
  return { ok:true };
}
async function ghPutFile(env, branch, path, contentJson, message) {
  const existingSha = await ghGetSha(env, path, branch);
  const body = {
    message,
    content: btoa(unescape(encodeURIComponent(JSON.stringify(contentJson, null, 2)))),
    branch,
    ...(existingSha ? { sha: existingSha } : {})
  };
  const res = await fetch(API_CONTENTS(env.DATA_OWNER, env.DATA_REPO, path), {
    method: 'PUT',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.GH_TOKEN_DATA}`
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) return { ok:false, status: res.status, error: await res.text().catch(()=> 'write_failed') };
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
    body: JSON.stringify({ title, head: branch, base: env.DATA_BASE || 'main' })
  });
  if (!res.ok) return null;
  const pr = await res.json();
  return pr && pr.html_url || null;
}

const ropaPath = (orgId, processId) =>
  `data/tenants/${orgId}/ropa/${processId}.json`;

export async function listProcesses(env, orgId) {
  const path = `data/tenants/${orgId}/ropa/ropa.json`;
  const res = await ghReadJson(env, path);  // sollte ref = DATA_BASE verwenden
  if (!res?.ok) {
    return []; // kein ropa.json → leeres Verzeichnis
  }

  const data = res.data || {};
  if (Array.isArray(data.processes)) {
    return data.processes;
  }
  if (Array.isArray(data)) {
    return data;
  }
  return [];
}




export async function readProcess(env, orgId, processId) {
  return await ghReadJson(env, ropaPath(orgId, processId));
}
export async function writeProcess(env, orgId, processId, doc) {
  const base = env.DATA_BASE || 'main';
  const branch = `ropa/${orgId}/${processId}/${Date.now()}`;
  const okBranch = await ghEnsureBranch(env, base, branch);
  if (!okBranch.ok) return { ok:false, error: okBranch.error };

  const put = await ghPutFile(env, branch, ropaPath(orgId, processId), doc, `feat(ropa): ${orgId}/${processId} update`);
  if (!put.ok) return put;

  const prUrl = await ghOpenPr(env, branch, `[RoPA] ${orgId}/${processId}`);
  return { ok:true, branch, prUrl };
}

// in workers/libs/tenantRopa.mjs

export async function importXdomeaIntoTenant(env, orgId, payload = {}) {
  const res = await ingestXdomea(env, payload);
  if (!res?.ok) return { ok:false, error: res?.error || 'ingest_failed' };

  const created = [];
  for (const proc of res.items) {
    const title = proc.title || proc.id;
    const profileHref = payload.profileHref || env.DEFAULT_PROFILE_HREF || undefined;

    const ssp = buildMinimalSSP({ title, profileHref });

    const bundleId = `bundle-${proc.id}`;
    const refBranch = payload.ref && payload.ref.trim();

    const put = await putTenantBundle(
      env,
      orgId,
      bundleId,
      { title, slug: proc.id, profileHref, ssp },
      { ref: refBranch }  // <--- hier
    );

    // HIER ändern:
    if (!put?.ok) {
      return {
        ok: false,
        error: put.error || 'write_failed',
        detail: put.detail || proc.id
      };
    }

    created.push({
      processId: proc.id,
      sspHref: put.sspHref,
      prUrl: put.prUrl || null
    });
  }
  const refBranch = (payload.ref && payload.ref.trim()) || null;
  if (refBranch) {
    const base = env.DATA_BASE || 'main';
    const mk = await ensureBranch(env, base, refBranch);
    if (!mk?.ok) {
      return {
        ok: false,
        error: 'write_failed',
        detail: mk.error || 'ensure_branch_failed'
      };
    }
    const branch = mk.branch || refBranch;

    // ROPA-Dokument aufbauen
    const processMap = new Map(res.items.map(p => [p.id, p]));
    const ropaDoc = {
      orgId,
      updatedAt: new Date().toISOString(),
      processes: created.map(c => {
        const p = processMap.get(c.processId) || { id: c.processId, title: c.processId };
        return {
          id: c.processId,
          title: p.title || c.processId,
          sspHref: c.sspHref
        };
      })
    };

    const path = `data/tenants/${orgId}/ropa/ropa.json`;
    const put = await putJsonFile(env, branch, path, ropaDoc, `feat(ropa): update ${orgId}/ropa`);
    if (!put.ok) {
      return { ok:false, error:'write_failed', detail: put.error || 'write_ropa_failed' };
    }
  }

  return {
    ok: true,
    created,
    next: {
      ropaHref: `/api/tenants/${encodeURIComponent(orgId)}/ropa`,
      proceduresHref: `/api/tenants/${encodeURIComponent(orgId)}/procedures`
    }
  };

}

