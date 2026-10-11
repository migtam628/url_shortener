import { open, type Reader, type CityResponse } from 'maxmind';
import { env } from '../env.js';
import { logger } from '../logger.js';

/**
 * MaxMind GeoLite2 lookups.
 *
 * The database is not in the repo (MaxMind's licence forbids redistribution
 * and it is ~60MB), so its absence is an expected state, not an error: the
 * worker runs regardless and geo columns stay null. `scripts/update-geoip.sh`
 * fetches it once a licence key is configured.
 */

let reader: Reader<CityResponse> | null = null;
let loadAttempted = false;

export async function initGeoip(): Promise<boolean> {
  if (loadAttempted) return reader !== null;
  loadAttempted = true;
  try {
    reader = await open<CityResponse>(env.GEOIP_DB_PATH);
    logger.info({ path: env.GEOIP_DB_PATH }, 'GeoIP database loaded');
    return true;
  } catch {
    logger.warn(
      { path: env.GEOIP_DB_PATH },
      'GeoIP database not found — clicks will be recorded without geo data. Run scripts/update-geoip.sh to enable it.',
    );
    reader = null;
    return false;
  }
}

export function geoipAvailable(): boolean {
  return reader !== null;
}

export interface GeoResult {
  country: string | null;
  region: string | null;
  city: string | null;
}

const EMPTY: GeoResult = { country: null, region: null, city: null };

export function lookupGeo(ip: string | null | undefined): GeoResult {
  if (!ip || !reader) return EMPTY;
  try {
    const res = reader.get(ip);
    if (!res) return EMPTY;
    return {
      country: res.country?.iso_code ?? res.registered_country?.iso_code ?? null,
      region: res.subdivisions?.[0]?.names?.en ?? null,
      city: res.city?.names?.en ?? null,
    };
  } catch {
    return EMPTY;
  }
}

/** Reset state. Test-only. */
export function _resetGeoip(): void {
  reader = null;
  loadAttempted = false;
}
