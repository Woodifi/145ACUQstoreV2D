// =============================================================================
// QStore IMS v2 — Unit sub-structure helpers
// =============================================================================
// Provides access to the company / platoon / section hierarchy that the CO
// configures in Settings → Unit sub-structure.
//
// STORAGE KEY
//   'unitStructure' in the settings KV store.
//   Value: array of company objects (see schema below), or null / [] if not
//   configured (the app degrades gracefully to free-text platoon entry).
//
// CONFIG SCHEMA
//   [
//     {
//       name:     'A Coy',
//       platoons: [
//         { name: '1 Plt', sections: ['1 Sec', '2 Sec', '3 Sec'] },
//         { name: '2 Plt', sections: ['1 Sec', '2 Sec'] },
//       ],
//     },
//     { name: 'HQ Coy', platoons: [{ name: 'HQ Plt', sections: [] }] },
//   ]
//
// CADET SCHEMA ADDITIONS (fields added to cadet records)
//   company  — company name, e.g. 'A Coy'
//   platoon  — platoon name, e.g. '1 Plt'  (replaces legacy 'plt' field)
//   section  — section name, e.g. '1 Sec'
//
//   Legacy records without company/platoon/section fall back to plt.
//   On first save after the upgrade, plt → platoon migration happens
//   automatically in the cadet form submit handler.
// =============================================================================

import * as Storage from './storage.js';

// -----------------------------------------------------------------------------
// Load / save
// -----------------------------------------------------------------------------

/**
 * Load the unit structure from settings.
 * @returns {Promise<Array>} Array of company objects (may be empty).
 */
export async function load() {
  const raw = await Storage.settings.get('unitStructure');
  return Array.isArray(raw) && raw.length > 0 ? raw : [];
}

/**
 * Save the unit structure to settings.
 * @param {Array} structure
 */
export async function save(structure) {
  await Storage.settings.set('unitStructure', structure);
}

// -----------------------------------------------------------------------------
// Derived lists (pure — take structure as argument)
// -----------------------------------------------------------------------------

/**
 * Get the ordered list of company names from the structure.
 * @param {Array} structure
 * @returns {string[]}
 */
export function getCompanies(structure) {
  return (structure || []).map((c) => c.name).filter(Boolean);
}

/**
 * Get the ordered list of platoon names for a given company.
 * @param {Array} structure
 * @param {string} companyName
 * @returns {string[]}
 */
export function getPlatoons(structure, companyName) {
  const company = (structure || []).find((c) => c.name === companyName);
  return company ? (company.platoons || []).map((p) => p.name).filter(Boolean) : [];
}

/**
 * Get the ordered list of section names for a given company and platoon.
 * @param {Array} structure
 * @param {string} companyName
 * @param {string} platoonName
 * @returns {string[]}
 */
export function getSections(structure, companyName, platoonName) {
  const company = (structure || []).find((c) => c.name === companyName);
  if (!company) return [];
  const platoon = (company.platoons || []).find((p) => p.name === platoonName);
  return platoon ? (platoon.sections || []).filter(Boolean) : [];
}

/**
 * Get the config-defined index (0-based) for a company name.
 * Returns Infinity if the company is not in the config (sorts to end).
 * @param {Array} structure
 * @param {string} name
 * @returns {number}
 */
export function companyIndex(structure, name) {
  if (!name) return Infinity;
  const idx = (structure || []).findIndex((c) => c.name === name);
  return idx === -1 ? Infinity : idx;
}

/**
 * Get the config-defined index for a platoon within a company.
 * Returns Infinity if not in config.
 * @param {Array} structure
 * @param {string} companyName
 * @param {string} platoonName
 * @returns {number}
 */
export function platoonIndex(structure, companyName, platoonName) {
  if (!platoonName) return Infinity;
  const company = (structure || []).find((c) => c.name === companyName);
  if (!company) return Infinity;
  const idx = (company.platoons || []).findIndex((p) => p.name === platoonName);
  return idx === -1 ? Infinity : idx;
}

/**
 * Get the config-defined index for a section within a company/platoon.
 * Returns Infinity if not in config.
 * @param {Array} structure
 * @param {string} companyName
 * @param {string} platoonName
 * @param {string} sectionName
 * @returns {number}
 */
export function sectionIndex(structure, companyName, platoonName, sectionName) {
  if (!sectionName) return Infinity;
  const company = (structure || []).find((c) => c.name === companyName);
  if (!company) return Infinity;
  const platoon = (company.platoons || []).find((p) => p.name === platoonName);
  if (!platoon) return Infinity;
  const idx = (platoon.sections || []).indexOf(sectionName);
  return idx === -1 ? Infinity : idx;
}

/**
 * Sort comparator for cadet records that uses company → platoon → section
 * order from the structure config, then falls back to rank → surname.
 *
 * Staff records always sort before cadets; within staff, rank → surname.
 *
 * @param {Array} structure  — result of load()
 * @param {Function} compareRanksFn — compareRanks from ranks.js
 * @returns {Function} comparator (a, b) => number
 */
export function makeComparator(structure, compareRanksFn) {
  return function compareCadet(a, b) {
    const typeA = a.personType === 'staff' ? 0 : 1;
    const typeB = b.personType === 'staff' ? 0 : 1;
    const typeDiff = typeA - typeB;
    if (typeDiff !== 0) return typeDiff;

    // Staff sort by rank then surname only — no company grouping.
    if (a.personType === 'staff') {
      return compareRanksFn(a.rank, b.rank) ||
        (a.surname || '').localeCompare(b.surname || '');
    }

    // Cadets: sort by company → platoon → section (config order), then rank → surname.
    const aCompany  = a.company  || '';
    const bCompany  = b.company  || '';
    const aPlatoon  = a.platoon  || a.plt || '';
    const bPlatoon  = b.platoon  || b.plt || '';
    const aSection  = a.section  || '';
    const bSection  = b.section  || '';

    const coDiff   = companyIndex(structure, aCompany)  - companyIndex(structure, bCompany);
    if (coDiff !== 0) return coDiff;

    const pltDiff  = platoonIndex(structure, aCompany,  aPlatoon) - platoonIndex(structure, bCompany,  bPlatoon);
    if (pltDiff !== 0) return pltDiff;

    const secDiff  = sectionIndex(structure, aCompany, aPlatoon, aSection) - sectionIndex(structure, bCompany, bPlatoon, bSection);
    if (secDiff !== 0) return secDiff;

    return compareRanksFn(a.rank, b.rank) ||
      (a.surname || '').localeCompare(b.surname || '');
  };
}
