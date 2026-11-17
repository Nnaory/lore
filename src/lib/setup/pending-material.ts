/**
 * Pending material
 *
 * A one-slot handoff from the home page's chat field to /create: the player
 * types or attaches material at "/", and /create picks it up and reads it as
 * if it had been added there.
 *
 * It is a module variable, not storage, because a File cannot be serialised
 * and the handoff is a client-side navigation that keeps the module alive.
 * A hard reload in between loses it, which only means an empty /create form.
 */

export type PendingMaterial = { kind: "file"; file: File } | { kind: "text"; text: string };

let pending: PendingMaterial | null = null;

/** Leave material for the next visit to /create, replacing anything not yet taken. */
export function setPendingMaterial(material: PendingMaterial): void {
  pending = material;
}

/** Take the waiting material, or null. Each handoff can be taken once. */
export function takePendingMaterial(): PendingMaterial | null {
  const material = pending;
  pending = null;
  return material;
}
