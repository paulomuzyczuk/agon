import {
  findLatestRunOnDate,
  insertManualRun,
  updateRunQualitative,
} from '../runs';
import { findFuelingProductByName, insertRunFuelingItem } from '../fueling';
import type { RunParse } from './schemas';
import { fuelingServings } from '../../lib/fuelingCatalog';

// Fan a parsed run note out onto the matching `runs` row and into structured
// fueling. Run resolution: enrich the latest run on the date; if none exists and
// a distance was spoken, create a minimal manual run so fueling can attach;
// otherwise leave the run unlinked (the qualitative_log still captured it) and
// report that. Each spoken product resolves against the catalog by name —
// unmatched names are collected and surfaced for a catalog add, never guessed.

export interface RunFanOutResult {
  runId: string | null;
  runCreated: boolean;
  fuelingItemsInserted: number;
  /** Ids of the run_fueling_items inserted (for /undo targeting). */
  fuelingItemIds: string[];
  /** Product names spoken but not found in the catalog — flag for a catalog add. */
  unmatchedProducts: string[];
  /** Catalog products whose spoken amount couldn't be converted to servings
   *  (e.g. grams of a product with no serving mass) — flagged, not guessed. */
  unconvertibleAmounts: string[];
}

/** Raw fueling text preserved on runs.fueling (structured intake goes to items). */
function fuelingSummary(parse: RunParse): string | null {
  if (parse.fueling.length === 0) return null;
  const parts = parse.fueling.map((f) => {
    const qty =
      f.amount != null
        ? `${f.amount}${f.unit && f.unit !== 'serving' ? ` ${f.unit}` : '×'} `
        : f.quantity != null
          ? `${f.quantity}× `
          : '';
    const at = f.timing_km != null ? ` @ ${f.timing_km}km` : '';
    return `${qty}${f.product ?? 'unknown'}${at}`.trim();
  });
  return parts.join('; ');
}

export async function fanOutRun(
  parse: RunParse,
  effectiveDate: string,
): Promise<RunFanOutResult> {
  const existing = await findLatestRunOnDate(effectiveDate);
  let runId = existing?.id ?? null;
  let runCreated = false;

  // No run yet but a distance was spoken → create a placeholder to attach to.
  if (!runId && parse.distance_km != null && parse.distance_km > 0) {
    runId = await insertManualRun({
      date: effectiveDate,
      distanceKm: parse.distance_km,
    });
    runCreated = true;
  }

  if (runId) {
    await updateRunQualitative(runId, {
      fueling: fuelingSummary(parse),
      perceivedEffort: parse.perceived_effort,
      painLocation: parse.pain_or_discomfort?.location ?? null,
      painOnsetKm: parse.pain_or_discomfort?.onset_km ?? null,
      generalNotes: parse.general_notes,
      shoeUsed: parse.shoe_used,
    });
  }

  const unmatchedProducts: string[] = [];
  const unconvertibleAmounts: string[] = [];
  const fuelingItemIds: string[] = [];

  if (runId) {
    for (const item of parse.fueling) {
      if (!item.product) continue;
      const product = await findFuelingProductByName(item.product);
      if (!product) {
        unmatchedProducts.push(item.product);
        continue;
      }
      const quantity = fuelingServings(product.name, item);
      if (quantity == null) {
        unconvertibleAmounts.push(
          `${product.name} (${item.amount} ${item.unit})`,
        );
        continue;
      }
      const itemId = await insertRunFuelingItem({
        runId,
        productId: product.id,
        quantity,
        timingKm: item.timing_km,
        notes: null,
      });
      fuelingItemIds.push(itemId);
    }
  }

  return {
    runId,
    runCreated,
    fuelingItemsInserted: fuelingItemIds.length,
    fuelingItemIds,
    unmatchedProducts,
    unconvertibleAmounts,
  };
}
