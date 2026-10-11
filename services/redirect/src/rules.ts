/**
 * Rule resolution seam — Phase 2.
 *
 * The redirect service already calls `resolveDestination` on every request,
 * so turning on geo/device/language targeting and A/B splits later is a
 * change to this one file plus the rule loader in the cache layer. Nothing on
 * the hot path has to be restructured.
 *
 * The default implementation returns the link's own destination, which is
 * exactly Phase 0/1 behaviour.
 *
 * See docs/ARCHITECTURE.md § "Phase 2 seams" for the full design, including
 * the sticky-assignment cookie for A/B.
 */

import type { ResolvedLink } from '@mtlink/shared';

export interface RequestContext {
  /** Two-letter country from GeoIP or the CDN edge header. */
  country: string | null;
  region: string | null;
  deviceType: string | null;
  os: string | null;
  language: string | null;
  referrerHost: string | null;
  /** Value of the A/B sticky cookie, when the visitor already has one. */
  abAssignment: string | null;
}

export interface RuleOutcome {
  destination: string;
  /** The rule that matched, recorded on the click row for attribution. */
  ruleId: string | null;
  /** Set when the response should also write a sticky A/B cookie. */
  setAbCookie?: { value: string; maxAgeSeconds: number };
}

/**
 * Pick the destination for this request.
 *
 * Phase 2 contract, for whoever implements it:
 *  - rules are evaluated in ascending `priority`; first match wins
 *  - a non-matching rule falls through to the next
 *  - `ab` rules are weighted random, but only for a visitor with no existing
 *    assignment; a returning visitor must get the same variant or the test
 *    measures nothing
 *  - no match at all returns `link.destination`
 */
export function resolveDestination(link: ResolvedLink, _ctx: RequestContext): RuleOutcome {
  // TODO(phase-2): evaluate link.rules here.
  // Deliberately a pass-through rather than a half-written matcher: a
  // partially-correct rule engine on the redirect path is worse than none.
  return { destination: link.destination, ruleId: null };
}

/**
 * Security gate seam — Phase 2 (password, expiry, click limits, cloaking).
 *
 * Returns null when the link should be served normally.
 */
export function checkSecurity(
  _link: ResolvedLink,
  _ctx: RequestContext,
): { action: 'password' | 'expired' | 'cloak'; redirect?: string } | null {
  // TODO(phase-2): enforce link.security here.
  return null;
}
