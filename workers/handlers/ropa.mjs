// handlers/ropa.mjs

import { parseXdomeaToRopa } from '../libs/mapping.mjs';

export async function ropaPreviewHandler(req, env) {
  try {
    const url = new URL(req.url);
    const href = url.searchParams.get('href');
    const orgId = url.searchParams.get('org') || 'demo-org';
    if (!href) {
      return new Response(JSON.stringify({ ok:false, error:'missing href' }), { status: 400 });
    }

    // Quelle laden
    const resp = await fetch(href, { headers: { accept: 'application/json,application/xml;q=0.9,*/*;q=0.8' }});
    if (!resp.ok) {
      return new Response(JSON.stringify({ ok:false, error:`fetch_failed:${resp.status}` }), { status: 502 });
    }
    const ct = resp.headers.get('content-type') || 'application/octet-stream';
    const buf = await resp.text();

    const ropa = await parseXdomeaToRopa(buf, ct);
    return new Response(JSON.stringify({ ok:true, orgId, ropa }), {
      headers: { 'content-type':'application/json; charset=utf-8', 'access-control-allow-origin':'*' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok:false, error:'server_error', detail: String(e?.message || e) }), { status: 500 });
  }
}

// POST /api/tenants/:orgId/bundles
// { "title": "...", "profileHref": "optional", "template": "minimal|process", "processId": "..." }
export async function createBundleHandler(req, env, params) {
  try {
    const orgId = params.orgId;
    const body = await req.json();
    const title = String(body.title || '').trim();
    const processId = String(body.processId || '').trim();
    if (!title) return new Response(JSON.stringify({ ok:false, error:'missing title' }), { status: 400 });

    const slug = processId || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const bundleId = `bundle-${Date.now().toString().slice(-6)}`;
    const profileHref = body.profileHref || env.DEFAULT_PROFILE_HREF || undefined;

    // SSP erzeugen (Minimal)
    const ssp = buildMinimalSSP({ title, profileHref });

    // ablegen unter data/tenants/<orgId>/bundles/<bundleId>/
    const write = await putTenantBundle(env, orgId, bundleId, {
      title, slug, profileHref, ssp
    });
    if (!write?.ok) return new Response(JSON.stringify({ ok:false, error:'write_failed' }), { status: 500 });

    return new Response(JSON.stringify({
      ok: true,
      orgId,
      bundleId,
      sspHref: write.sspHref,
      prUrl: write.prUrl || null
    }), { headers: { 'content-type':'application/json; charset=utf-8', 'access-control-allow-origin':'*' }});
  } catch (e) {
    return new Response(JSON.stringify({ ok:false, error:'server_error', detail: String(e?.message || e) }), { status: 500 });
  }
}
