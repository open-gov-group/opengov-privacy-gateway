// workers/libs/tenantProcedures.mjs

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
  return Array.isArray(items) ? items.filter(x => x.type === 'dir').map(x => x.name) : [];
}

async function ghGetSha(env, path, ref) {
  const url = `${API_CONTENTS(env.DATA_OWNER, env.DATA_REPO, path)}?ref=${ref}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/vnd.github+json' } });
  if (!res.ok) return null;
  const meta = await res.json();
  return meta && meta.sha || null;
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

async function ghEnsureBranch(env, base, branch) {
  // hole base ref sha
  const refUrl = `https://api.github.com/repos/${env.DATA_OWNER}/${env.DATA_REPO}/git/ref/heads/${base}`;
  const refRes = await fetch(refUrl, { headers: { 'Accept': 'application/vnd.github+json' } });
  if (!refRes.ok) return { ok:false, error: 'base_ref_not_found' };
  const ref = await refRes.json();
  const sha = ref.object && ref.object.sha;

  // versuche neuen Branch zu erstellen
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

  if (createRes.status === 422) {
    // existiert schon -> OK
    return { ok:true };
  }
  if (!createRes.ok) {
    const t = await createRes.text().catch(()=> '');
    return { ok:false, error: t || 'create_branch_failed' };
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

export async function listSSPs(env, orgId) {
  return await ghList(env, `data/tenants/${orgId}/procedures`);
}

export async function readSSP(env, orgId, sspId) {
  return await ghReadJson(env, sspPath(orgId, sspId));
}

export async function writeSSP(env, orgId, sspId, doc) {
  const base = env.DATA_BASE || 'main';
  const branch = `procedure/${orgId}/${sspId}/${Date.now()}`;

  const okBranch = await ghEnsureBranch(env, base, branch);
  if (!okBranch.ok) return { ok:false, error: okBranch.error };

  const path = sspPath(orgId, sspId);
  const put = await ghPutFile(env, branch, path, doc, `feat(procedure): ${orgId}/${sspId} update SSP`);

  if (!put.ok) return put;

  const prUrl = await ghOpenPr(env, branch, `[SSP] ${orgId}/${sspId}`);
  return { ok:true, branch, prUrl };
}
