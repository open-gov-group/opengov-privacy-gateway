// workers/libs/oscal.mjs
export async function templateSsp(env, profileHref) {
  const candidates = [];
  if (env.TEMPLATE_SSP_HREF) candidates.push(env.TEMPLATE_SSP_HREF);
  candidates.push('https://raw.githubusercontent.com/open-gov-group/opengov-privacy-oscal/main/oscal/ssp/ssp_template_ropa.json');

  for (const href of candidates) {
    try {
      const r = await fetch(href, { cf: { cacheEverything:true, cacheTtl:300 }});
      if (!r.ok) continue;
      const tpl = await r.json();
      const ssp = tpl?.['system-security-plan'];
      if (!ssp) continue;
      if (profileHref && !ssp['import-profile']) ssp['import-profile'] = { href: profileHref };
      ssp.uuid = ssp.uuid || crypto.randomUUID();
      ssp.metadata = ssp.metadata || {};
      ssp.metadata['oscal-version'] = ssp.metadata['oscal-version'] || '1.1.2';
      ssp.metadata['last-modified'] = ssp.metadata['last-modified'] || new Date().toISOString();
      ssp['system-characteristics'] = ssp['system-characteristics'] || {
        'system-ids': [{ 'identifier-type': 'assigned', id: 'SSP-RoPA-XXX' }],
        'system-name': 'Processing activity – <Title>',
        'system-name-short': 'PA-<Short>',
        description: 'Short description.',
        status: { state: 'operational' },
        'security-sensitivity-level': 'moderate',
        'system-information': { 'information-types': [{ title: 'Personal data (GDPR)', description: 'Typical RoPA categories.' }] },
        props: [{ name: 'ropa:purpose', value: '<purpose(s)>' }],
        'authorization-boundary': { description: 'Scope.' }
      };
      ssp['system-implementation'] = ssp['system-implementation'] || { users: [], components: [] };
      ssp['control-implementation'] = ssp['control-implementation'] || { description: 'Implementation per profile/catalog.', 'implemented-requirements': [] };
      ssp['back-matter'] = ssp['back-matter'] || { resources: [] };
      return tpl;
    } catch {}
  }

  // Minimal-Fallback
  return {
    'system-security-plan': {
      uuid: crypto.randomUUID(),
      metadata: { title: 'SSP (RoPA) – Template', 'last-modified': new Date().toISOString(), version: '0.2.0', 'oscal-version': '1.1.2' },
      ...(profileHref ? { 'import-profile': { href: profileHref } } : {}),
      'system-characteristics': {
        'system-ids': [{ 'identifier-type': 'assigned', id: 'SSP-RoPA-XXX' }],
        'system-name': 'Processing activity – <Title>',
        'system-name-short': 'PA-<Short>',
        description: 'Short description',
        status: { state: 'operational' },
        'security-sensitivity-level': 'moderate',
        'system-information': { 'information-types': [{ title: 'Personal data (GDPR)', description: 'Typical RoPA categories.' }] },
        props: [{ name: 'ropa:purpose', value: '<purpose(s)>' }],
        'authorization-boundary': { description: 'Scope.' }
      },
      'system-implementation': { users: [], components: [] },
      'control-implementation': { description: 'Implementation per profile/catalog.', 'implemented-requirements': [] },
      'back-matter': { resources: [] }
    }
  };
}
