// workers/libs/tenantProfile.mjs

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

const profilePath = (orgId, profileId) =>
  `data/tenants/${orgId}/profiles/${profileId}.json`;

export async function listProfiles(env, orgId) {
  return await ghList(env, `data/tenants/${orgId}/profiles`);
}
export async function readProfile(env, orgId, profileId) {
  return await ghReadJson(env, profilePath(orgId, profileId));
}
export async function writeProfile(env, orgId, profileId, doc) {
  const base = env.DATA_BASE || 'main';
  const branch = `profile/${orgId}/${profileId}/${Date.now()}`;
  const okBranch = await ghEnsureBranch(env, base, branch);
  if (!okBranch.ok) return { ok:false, error: okBranch.error };

  const put = await ghPutFile(env, branch, profilePath(orgId, profileId), doc, `feat(profile): ${orgId}/${profileId} update`);
  if (!put.ok) return put;

  const prUrl = await ghOpenPr(env, branch, `[Profile] ${orgId}/${profileId}`);
  return { ok:true, branch, prUrl };
}
