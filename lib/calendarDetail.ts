import { getLiftDetail } from './training/sessionDetails';

// The "detail" block of a bike or lift calendar event (MZY-262): the exercise
// list of a lift, the notes of a ride. The program writes a default one; the
// athlete may rewrite it by hand in Google Calendar, and that version then wins
// (session_adjustments.detail). Both directions use this module so the push and
// the reconcile agree on exactly what "the detail" is — if they disagreed, every
// sync would see a phantom edit.
//
// A detail line is SAFE HTML: escaped text, optionally with <a href="https://…">
// links (a hand-written route). Pure — no DB, no network.

/** The bike event's default detail line (bike has no structured detail library). */
export const BIKE_DEFAULT_DETAIL =
  'Easy Zone 2 spin — low-impact aerobic reserve, not a training target';

/** Agon's own route section headers — their bullets are regenerated, never kept. */
const AGON_ROUTE_HEADERS = [
  '🗺️ Suggested routes from home:',
  '🧭 Ad hoc routes:',
];

/** Plain-text prefixes of the description lines Agon writes outside the detail. */
const AGON_LINE_PREFIXES = [
  '📝',
  '⏰',
  'Target:',
  'HR cap:',
  'Quality session — no HR cap',
  '🧴',
  '🥤',
];

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

/** Tags removed, entities decoded, whitespace collapsed. */
function toPlain(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

const ANCHOR = /<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;

/**
 * Re-emit one line of (possibly hand-written) HTML as safe HTML: every tag is
 * dropped except http(s) links, which are rebuilt from their href and text.
 * Idempotent, so a stored detail line survives any number of round trips.
 */
export function sanitizeDetailLine(html: string): string {
  let out = '';
  let last = 0;
  for (const m of html.matchAll(ANCHOR)) {
    out += escapeHtml(toPlain(html.slice(last, m.index)));
    const href = decodeEntities(m[2] ?? '').trim();
    const text = toPlain(m[3] ?? '');
    out += /^https?:\/\//i.test(href)
      ? `<a href="${escapeAttr(href)}">${escapeHtml(text || href)}</a>`
      : escapeHtml(text);
    last = (m.index ?? 0) + m[0].length;
  }
  out += escapeHtml(toPlain(html.slice(last)));
  // toPlain trims each segment; restore the single space a link usually sits after.
  return out.replace(/(\S)(<a )/g, '$1 $2').replace(/(<\/a>)(\S)/g, '$1 $2');
}

/** A Calendar event description (HTML from Agon or the Calendar editor) as lines. */
export function descriptionToLines(html: string | undefined): string[] {
  if (!html) return [];
  return html
    .replace(/\r\n?/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|ul|ol)\b[^>]*>/gi, '\n')
    .split('\n')
    .map(sanitizeDetailLine);
}

function lineText(line: string): string {
  return toPlain(line);
}

/**
 * The athlete-authored detail in an event description: every line Agon did not
 * generate. Dropped: the leading "Block N · Week M", Agon's note/target/fueling
 * lines, its own route sections (header + bullets) and "Planned by Agon". Inner
 * blank lines are kept (collapsed to one) because they lay out the athlete's
 * sections; leading/trailing ones are trimmed.
 */
export function extractAthleteDetail(lines: string[]): string[] {
  const kept: string[] = [];
  let inAgonRoutes = false;
  for (const line of lines) {
    const t = lineText(line);
    if (t === '') {
      inAgonRoutes = false;
      if (kept.length > 0 && kept[kept.length - 1] !== '') kept.push('');
      continue;
    }
    if (AGON_ROUTE_HEADERS.includes(t)) {
      inAgonRoutes = true;
      continue;
    }
    if (inAgonRoutes && t.startsWith('•')) continue;
    inAgonRoutes = false;
    if (/^Block \d+ · Week \d+$/.test(t)) continue;
    if (t === 'Planned by Agon') continue;
    if (AGON_LINE_PREFIXES.some((p) => t.startsWith(p))) continue;
    kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
  return kept;
}

/** The program's own detail lines for a bike or lift (safe HTML, no blanks). */
export function programDetailLines(
  sessionKind: 'run' | 'lift' | 'bike',
  sessionType: string | null,
): string[] {
  if (sessionKind === 'bike') return [escapeHtml(BIKE_DEFAULT_DETAIL)];
  if (sessionKind !== 'lift') return [];
  const lift = getLiftDetail(sessionType);
  if (lift)
    return lift.map((ex) => escapeHtml(`${ex.exercise} — ${ex.scheme}`));
  return sessionType ? [escapeHtml(`Session: ${sessionType}`)] : [];
}

/** The detail the event renders: the athlete's override, else the program's. */
export function resolvedDetailLines(
  sessionKind: 'run' | 'lift' | 'bike',
  sessionType: string | null,
  detail: string | null | undefined,
): string[] {
  return detail != null
    ? detail.split('\n').map(sanitizeDetailLine)
    : programDetailLines(sessionKind, sessionType);
}

/** Two details are the same edit if their non-blank lines match. */
export function sameDetail(a: string[], b: string[]): boolean {
  const nb = (xs: string[]) => xs.filter((x) => x !== '');
  const x = nb(a);
  const y = nb(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** True when a detail carries its own link — the athlete's route for that session. */
export function detailHasOwnRoute(detail: string | null | undefined): boolean {
  return detail != null && /<a href="https?:\/\//i.test(detail);
}
