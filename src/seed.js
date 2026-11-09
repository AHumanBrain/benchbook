// Batches imported from the lab workbook (data/seed.json). Pure: no DOM, no storage.
//
// A seeded batch is a normal batch you can edit. While it is still exactly as imported ("pristine") it counts as
// reproducible, so a backup file with your edited version of it wins over the pristine copy, never the other way round.

const clone = x => JSON.parse(JSON.stringify(x));

/** Small stable hash of any JSON-able value (not cryptographic: it only has to notice edits). */
export function fingerprint(value) {
  let h = 5381;
  const s = JSON.stringify(value);
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const sealed = b => {
  const { seedHash, ...rest } = b;
  return fingerprint(rest);
};

/** True for a seeded batch nobody has changed since it was imported. */
export const isPristineSeed = b => !!b && b.seed === true && !!b.seedHash && sealed(b) === b.seedHash;

/** Build one batch from a seed recipe: attach its protocol snapshot, fill defaults, seal it. */
export function hydrateBatch(seed, recipe, ensure) {
  const b = { ...clone(recipe), protocol: clone(seed.protocols[recipe.protocol]) };
  ensure(b);
  b.seedHash = sealed(b);
  return b;
}

/** Bring the seed's batches into `db`. Returns how many batches were added.
 *  - Missing batches are added; ones you deleted stay deleted unless `force` (the "restore" button).
 *  - When the seed's version changes, batches nobody has edited are replaced by the new version, and an edited batch only
 *    gains the links it was missing. Nothing else about an edited batch is ever touched. */
export function applySeed(db, seed, { force = false, ensure }) {
  db.settings.deleted ??= {};
  const versionChanged = db.settings.seedVersion !== seed.version;
  if (!force && !versionChanged) return 0;
  let added = 0;
  for (const recipe of seed.batches) {
    const existing = db.batches[recipe.id];
    if (existing) {
      if (versionChanged && isPristineSeed(existing)) db.batches[recipe.id] = hydrateBatch(seed, recipe, ensure);
      else if (versionChanged && recipe.links?.length && !existing.links?.length) {
        existing.links = [...recipe.links];
        existing.role ??= recipe.role;
      }
      continue;
    }
    if (!force && db.settings.deleted[recipe.id]) continue;
    db.batches[recipe.id] = hydrateBatch(seed, recipe, ensure);
    delete db.settings.deleted[recipe.id];
    added++;
  }
  for (const [id, plate] of Object.entries(seed.plates || {})) if (!db.plates[id]) db.plates[id] = clone(plate);
  db.settings.seedVersion = seed.version;
  return added;
}
