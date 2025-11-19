// ./lib/org-id.mjs

/** Normalisiert ein Token: entfernt Diakritika, nur [A-Za-z0-9], Trenner "-" */
export function norm(token = '') {
  return String(token)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')   // Diakritika
    .replace(/[^A-Za-z0-9]+/g, '-')    // Nicht-alphanum -> "-"
    .replace(/^-+|-+$/g, '')           // Trim "-"
    .toUpperCase();
}

/**
 * Baut eine deterministische Organisations-ID:
 * EU-DE-<COUNTY|-X>-<TOWNID|-X>-<TOWN>
 */
export function buildOrgId({ euCode = 'EU', stateCode, countyCode, townId, townName }) {
  const parts = [
    norm(euCode || 'EU'),
    norm(stateCode || ''),
    norm(countyCode || 'X'),
    norm(townId || 'X'),
    norm(townName || '')
  ];
  return parts.filter(Boolean).join('-');
}
