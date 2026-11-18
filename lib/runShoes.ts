// The running shoes offered in the Save form's dropdown (GET /api/gear/shoes).
// Shared by the route and the client so the shape can't drift.

export interface RunShoe {
  gearId: string;
  name: string;
  /** Start of the newest run logged in them, ISO; null if never used. */
  lastUsedAt: string | null;
}

export interface RunShoesResponse {
  /** Active shoes, most recently used first. The first one is the default. */
  shoes: RunShoe[];
}
