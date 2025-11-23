// workers/libs/oscal.mjs

function uuid() {
  return (globalThis.crypto?.randomUUID?.() ||
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0; // Fallback
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    }));
}




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

/**
 * buildMinimalSSP
 * Liefert ein sehr kleines, aber schema-konformes SSP-Objekt.
 * @param {{title?:string, profileHref?:string}} opt
 */
export function buildMinimalSSP(opt = {}) {
  const title = opt.title || 'SSP – Processing Activity';
  const profileHref = opt.profileHref;

  const ssp = {
    'system-security-plan': {
      uuid: uuid(),
      metadata: {
        title,
        'last-modified': new Date().toISOString(),
        version: '0.1.0',
        'oscal-version': '1.1.2'
      },
      ...(profileHref ? { 'import-profile': { href: profileHref } } : {}),
      'system-characteristics': {
        'system-ids': [{ 'identifier-type': 'assigned', id: 'SSP-RoPA-XXX' }],
        'system-name': 'Processing activity – <Title>',
        'system-name-short': 'PA-<Short>',
        description: 'Short description of the processing, purpose, legal basis, data subjects/data categories.',
        status: { state: 'operational' },
        'security-sensitivity-level': 'moderate',
        'system-information': {
          'information-types': [
            { title: 'Personal data (GDPR)', description: 'Typical RoPA categories.' }
          ]
        },
        props: [
          { name: 'ropa:purpose', value: '<purpose(s)>' },
          { name: 'ropa:data-categories', value: '<categories of personal data>' },
          { name: 'ropa:data-subjects', value: '<data subject categories>' },
          { name: 'ropa:recipients', value: '<recipients/categories>' },
          { name: 'ropa:third-country-transfers', value: '<No/Yes – legal basis>' },
          { name: 'ropa:retention', value: '<retention/erasure periods>' },
          { name: 'ropa:legal-basis', value: '<Art. 6 GDPR / sector law>' }
        ],
        'authorization-boundary': { description: 'Scope and boundary of the processing environment.' }
      },
      'system-implementation': {
        users: [],
        components: []
      },
      'control-implementation': {
        description: 'Implementation of controls per profile/catalog; reference components and evidence.',
        'implemented-requirements': []
      },
      'back-matter': { resources: [] }
    }
  };

  return ssp;
}

