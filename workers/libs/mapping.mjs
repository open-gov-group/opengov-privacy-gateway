// workers/libs/mapping.mjs

// We reuse the simple parser already written in handlers/ropa.mjs
export async function parseXdomeaToRopa(sourceText, contentType = 'application/xml') {
  const processes = [];

  if (contentType.includes('json') || sourceText.trim().startsWith('{')) {
    const j = JSON.parse(sourceText);
    const nodes = (j.root?.children ?? []).filter(n => n.tag === 'xdomea:Aktenplan');
    for (const n of nodes) {
      const label = (n.value?.children ?? []).find(c => c.tag === 'xdomea:Bezeichnung')?.value?.['#text'];
      if (label) {
        const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        processes.push({ id, title: label });
      }
    }
    return { processes };
  }

  // XML-Fall (vereinfachtes MVP)
  const bezeichnungen = [...sourceText.matchAll(/<xdomea:Bezeichnung>([^<]+)<\/xdomea:Bezeichnung>/g)]
    .map(m => m[1]);

  for (const title of bezeichnungen) {
    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    processes.push({ id, title });
  }

  return { processes };
}

export async function ingestXdomea(env, payload = {}) {
  try {
    let sourceText = null;
    let contentType = 'application/xml';

    // 1) Quelle bestimmen – OHNE "files"
    if (payload.xml) {
      sourceText = String(payload.xml);
      contentType = 'application/xml';
    } else if (payload.json) {
      if (typeof payload.json === 'string') {
        sourceText = payload.json;
        contentType = 'application/json';
      } else {
        sourceText = JSON.stringify(payload.json);
        contentType = 'application/json';
      }
    } else if (payload.url) {
      const resp = await fetch(payload.url, {
        headers: {
          accept: 'application/json,application/xml;q=0.9,*/*;q=0.8'
        }
      });
      if (!resp.ok) {
        return { ok: false, error: `fetch_failed:${resp.status}` };
      }
      contentType = resp.headers.get('content-type') || 'application/octet-stream';
      sourceText = await resp.text();
    } else {
      // WENN du später "files" wieder einführst, wäre hier der Platz,
      // aber nicht default.
      return { ok: false, error: 'missing_source' };
    }

    if (!sourceText) {
      return { ok: false, error: 'empty_source' };
    }

    // 2) XDOMEA -> RoPA-Prozesse
    const { processes } = await parseXdomeaToRopa(sourceText, contentType);

    const items = (processes || []).map(p => ({
      id: p.id,
      title: p.title
    }));

    return { ok: true, items };
  } catch (e) {
    return {
      ok: false,
      error: 'server_error',
      detail: String(e?.message || e)
    };
  }
}