// workers/src/router.mjs

import { json, ok, notFound, badRequest, withCORS, parseUrl, okOptions } from '../libs/base.mjs';
import { requireApiKey } from '../libs/secure.mjs';
import { templateSsp } from '../libs/oscal.mjs';
import {
  checkDataIfOrgIdExists,
  readTenantJson,
  initTenant,
  updateTenant,
  deleteTenant,
  saveTenantDraft, 
  mergeTenantBranch
} from '../libs/tenant.mjs';
import { ropaPreviewHandler, createBundleHandler } from '../handlers/ropa.mjs';


// Helper: simple path matcher :param
function match(pathPattern, actualPath) {
  const pp = pathPattern.split('/').filter(Boolean);
  const ap = actualPath.split('/').filter(Boolean);
  if (pp.length !== ap.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i++) {
    const p = pp[i], a = ap[i];
    if (p.startsWith(':')) {
      params[p.slice(1)] = decodeURIComponent(a);
    } else if (p !== a) {
      return null;
    }
  }
  return params;
}



export async function route(request, env, ctx) {
  const { pathname, searchParams } = parseUrl(request);
  
  if (request.method === 'OPTIONS' && pathname.startsWith('/api/')) {
    return okOptions(); // setzt Access-Control-Allow-Methods/Headers
  }

  // Health
  if (request.method === 'GET' && pathname === '/api/healthz') {
    return ok({
      ok: true,
      checks: {
        mode: env.MODE || 'unset',
        envVars: {
          MOCK_BASE: !!env.MOCK_BASE,
          DATA_OWNER: !!env.DATA_OWNER,
          DATA_REPO: !!env.DATA_REPO,
          DATA_BASE: env.DATA_BASE,
          DEFAULT_PROFILE_HREF: !!env.DEFAULT_PROFILE_HREF,
          TEMPLATE_SSP_HREF: !!env.TEMPLATE_SSP_HREF
        },
        secrets: {
          APP_API_KEY: env.APP_API_KEY,
          GH_TOKEN_DATA: env.GH_TOKEN_DATA,
          JWT_SECRET: env.JWT_SECRET
        }
      }
    });
  }

  // SSP Template (Profile optional)
  if (request.method === 'GET' && pathname === '/api/templates/ssp') {
    const profileHref = searchParams.get('profile') || env.DEFAULT_PROFILE_HREF || undefined;
    const tpl = await templateSsp(env, profileHref);
    return ok(tpl);
  }


  // --- Tenants ---
  // GET tenant meta
  {
    const m = match('/api/tenants/:orgId', pathname);
    if (request.method === 'GET' && m) {
      const exists = await checkDataIfOrgIdExists(env, m.orgId);
      if (!exists) return notFound(`tenant ${m.orgId}`);
      const r = await readTenantJson(env, m.orgId);
      if (!r.ok) return json({ error: 'read_failed', status: r.status }, 502);
      return ok(r.data);
    }
  }

  // POST init tenant
  {
    const m = match('/api/tenants/:orgId/init', pathname);
    if (request.method === 'POST' && m) {
      const gate = await requireApiKey(request, env);
      if (!gate.ok) return gate.response;
      const payload = await request.json().catch(() => ({}));
      const res = await initTenant(env, m.orgId, payload);
      if (!res.ok) return json({ error: res.error || 'init_failed' }, 502);
      return ok({ ok: true, orgId: m.orgId, created: { prUrl: res.prUrl, branch: res.branch }, next: res.next });
    }
  }

  // PUT /api/tenants/:orgId/save?ref=...
    {
    const m = match('/api/tenants/:orgId/save', pathname);
      if (request.method === 'PUT' && m ) {
        const gate = await requireApiKey(request, env);
        if (!gate.ok) return gate.response;
        const ref = searchParams.get('ref');
        if (!ref) return badRequest('missing ref');
        const body = await request.json().catch(()=> ({}));
        const res = await saveTenantDraft(env, m.orgId, body, ref);
        if (!res?.ok) return json({ error: res?.error || 'save_failed' }, 502);
        return ok({ ok:true, branch: res.branch, prUrl: res.prUrl ?? null });
      }
    }
  // POST /api/tenants/:orgId/merge?ref=...&base=...
    {
    const m = match('/api/tenants/:orgId/merge', pathname);
      if (request.method === 'POST' && m ) {
        const gate = await requireApiKey(request, env);
        if (!gate.ok) return gate.response;
        const ref = searchParams.get('ref');
        if (!ref) return badRequest('missing ref');
        const base = searchParams.get('base') || (env.DATA_BASE || 'main');
        //const res = await mergeTenantDraft(env, m.orgId, ref, base);
        const res = await mergeTenantBranch(env, { head: ref, base });
        if (!res?.ok) return json({ error: res?.error || 'merge_failed' }, 502);
        return ok({ ok:true, merged: !!res.merged, base, ref, commitSha: res.commitSha ?? null });
      }
    }

  // PUT update tenant
  {
    const m = match('/api/tenants/:orgId', pathname);
    if (request.method === 'PUT' && m) {
      const gate = await requireApiKey(request, env);
      if (!gate.ok) return gate.response;
      const body = await request.json().catch(() => ({}));
      const res = await updateTenant(env, m.orgId, body);
      if (!res.ok) return json({ error: res.error || 'update_failed' }, 502);
      return ok(res);
    }
  }

  // DELETE tenant (nur meta.json Demo)
  {
    const m = match('/api/tenants/:orgId', pathname);
    if (request.method === 'DELETE' && m) {
      const gate = await requireApiKey(request, env);
      if (!gate.ok) return gate.response;
      const res = await deleteTenant(env, m.orgId);
      if (!res.ok) return json({ error: res.error || 'delete_failed' }, 502);
      return ok(res);
    }
  }

   // --- Profiles ---
  {
    const m = match('/api/tenants/:orgId/profiles', pathname);
    if (request.method === 'GET' && m) {
      const { listProfiles } = await import('../libs/tenantProfile.mjs');
      const list = await listProfiles(env, m.orgId);
      return ok({ items: list });
    }
  }
  {
    const m = match('/api/tenants/:orgId/profiles/:profileId', pathname);
    if (request.method === 'GET' && m) {
      const { readProfile } = await import('../libs/tenantProfile.mjs');
      const doc = await readProfile(env, m.orgId, m.profileId);
      if (!doc) return notFound('profile');
      return ok(doc);
    }
    if (request.method === 'PUT' && m) {
      const gate = await requireApiKey(request, env);
      if (!gate.ok) return gate.response;
      const payload = await request.json().catch(()=> ({}));
      const { writeProfile } = await import('../libs/tenantProfile.mjs');
      const res = await writeProfile(env, m.orgId, m.profileId, payload);
      if (!res.ok) return json({ error: res.error || 'write_failed' }, 502);
      return ok(res);
    }
  }

  // --- Procedures (SSP) ---
  {
    const m = match('/api/tenants/:orgId/procedures', pathname);
    if (request.method === 'GET' && m) {
      const { listSSPs } = await import('../libs/tenantProcedures.mjs');
      const list = await listSSPs(env, m.orgId);
      return ok({ items: list });
    }
  }
  {
    const m = match('/api/tenants/:orgId/procedures/:sspId', pathname);
    if (request.method === 'GET' && m) {
      const { readSSP } = await import('../libs/tenantProcedures.mjs');
      const doc = await readSSP(env, m.orgId, m.sspId);
      if (!doc) return notFound('ssp');
      return ok(doc);
    }
    if (request.method === 'PUT' && m) {
      const gate = await requireApiKey(request, env);
      if (!gate.ok) return gate.response;
      const payload = await request.json().catch(()=> ({}));
      const { writeSSP } = await import('../libs/tenantProcedures.mjs');
      const res = await writeSSP(env, m.orgId, m.sspId, payload);
      if (!res.ok) return json({ error: res.error || 'write_failed' }, 502);
      return ok(res);
    }
  }

  // --- RoPA (process register) ---

  if (request.method === 'GET' && pathname.startsWith('/api/ropa/preview')) {
    return ropaPreviewHandler(request, env);
  }

  // Create bundle from UI
  {
    const m = match('/api/tenants/:orgId/bundles', pathname);
    if (request.method === 'POST' && m) {
      const gate = await requireApiKey(request, env);
      if (!gate.ok) return gate.response;
      return createBundleHandler(request, env, m);
    }
  }
  {
    const m = match('/api/ingest/xdomea', pathname);
    if (request.method === 'POST' && m) {
      const { ingestXdomea } = await import('../libs/mapping.mjs');
      const payload = await request.json().catch(()=> ({})); // { url?: string, xml?: string }
      const res = await ingestXdomea(env, payload);
      if (!res?.ok) return badRequest(res?.error || 'ingest_failed');
      return ok({ items: res.items }); // gleiche Struktur wie /api/tenants/:orgId/ropa
    }
  }
  {
    const m = match('/api/tenants/:orgId/ropa/import', pathname);
    if (request.method === 'POST' && m) {
      const gate = await requireApiKey(request, env);
      if (!gate.ok) return gate.response;
      const { importXdomeaIntoTenant } = await import('../libs/tenantRopa.mjs');
      const payload = await request.json().catch(()=> ({})); // { url?: string, xml?: string, template?: 'minimal'|'domain' }
      const res = await importXdomeaIntoTenant(env, m.orgId, payload);
      if (!res?.ok) return badRequest(res?.error || 'import_failed');
      return ok({ ok:true, created: res.created, next: res.next }); // z.B. Liste angelegter SSP-IDs
    }
  }

  {
    const m = match('/api/tenants/:orgId/ropa', pathname);
    if (request.method === 'GET' && m) {
      const { listProcesses } = await import('../libs/tenantRopa.mjs');
      const list = await listProcesses(env, m.orgId);
      return ok({ items: list });
    }
  }
  {
    const m = match('/api/tenants/:orgId/ropa/:processId', pathname);
    if (request.method === 'GET' && m) {
      const { readProcess } = await import('../libs/tenantRopa.mjs');
      const doc = await readProcess(env, m.orgId, m.processId);
      if (!doc) return notFound('process');
      return ok(doc);
    }
    if (request.method === 'PUT' && m) {
      const gate = await requireApiKey(request, env);
      if (!gate.ok) return gate.response;
      const payload = await request.json().catch(()=> ({}));
      const { writeProcess } = await import('../libs/tenantRopa.mjs');
      const res = await writeProcess(env, m.orgId, m.processId, payload);
      if (!res.ok) return json({ error: res.error || 'write_failed' }, 502);
      return ok(res);
    }
  }

  return null; // -> 404 im main.mjs
}
