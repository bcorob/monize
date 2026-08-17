import { HoldingWithMarketValue } from '@/types/investment';
import { chartColors, CHART_SERIES } from '@/lib/chart-colors';

export interface ExchangeAllocation {
  exchange: string;
  country: string;
  region: string;
  count: number;
  marketValue: number;
  percentage: number;
}

export interface RegionAllocation {
  region: string;
  marketValue: number;
  percentage: number;
  count: number;
  color: string;
}

/**
 * Maps a security's listing exchange to a country and broad geographic region.
 * Shared by the Geographic Allocation report and its dashboard widget so both
 * classify holdings identically.
 */
export const EXCHANGE_TO_REGION: Record<string, { country: string; region: string }> = {
  NYSE: { country: 'United States', region: 'North America' },
  NASDAQ: { country: 'United States', region: 'North America' },
  NMS: { country: 'United States', region: 'North America' },
  NYQ: { country: 'United States', region: 'North America' },
  NYSEARCA: { country: 'United States', region: 'North America' },
  AMEX: { country: 'United States', region: 'North America' },
  BATS: { country: 'United States', region: 'North America' },
  TSX: { country: 'Canada', region: 'North America' },
  TSXV: { country: 'Canada', region: 'North America' },
  TOR: { country: 'Canada', region: 'North America' },
  NEO: { country: 'Canada', region: 'North America' },
  LSE: { country: 'United Kingdom', region: 'Europe' },
  LON: { country: 'United Kingdom', region: 'Europe' },
  FRA: { country: 'Germany', region: 'Europe' },
  XETRA: { country: 'Germany', region: 'Europe' },
  PAR: { country: 'France', region: 'Europe' },
  AMS: { country: 'Netherlands', region: 'Europe' },
  MIL: { country: 'Italy', region: 'Europe' },
  STO: { country: 'Sweden', region: 'Europe' },
  TYO: { country: 'Japan', region: 'Asia-Pacific' },
  HKG: { country: 'Hong Kong', region: 'Asia-Pacific' },
  SHA: { country: 'China', region: 'Asia-Pacific' },
  SHE: { country: 'China', region: 'Asia-Pacific' },
  ASX: { country: 'Australia', region: 'Asia-Pacific' },
  KRX: { country: 'South Korea', region: 'Asia-Pacific' },
  TAI: { country: 'Taiwan', region: 'Asia-Pacific' },
  SGX: { country: 'Singapore', region: 'Asia-Pacific' },
  BSE: { country: 'India', region: 'Asia-Pacific' },
  NSE: { country: 'India', region: 'Asia-Pacific' },
};

export const REGION_COLOURS: Record<string, string> = {
  'North America': CHART_SERIES[0],
  Europe: CHART_SERIES[1],
  'Asia-Pacific': CHART_SERIES[2],
  Other: CHART_SERIES[3],
};

export const COUNTRY_COLOURS = CHART_SERIES;

/**
 * Roll holdings up into per-exchange and per-region allocations, all converted
 * into the user's display currency via `convertToDefault`. `securityExchangeMap`
 * maps securityId -> exchange code (from the securities list).
 */
export function computeGeographicAllocation(
  holdings: HoldingWithMarketValue[],
  securityExchangeMap: Map<string, string>,
  convertToDefault: (value: number, currency: string) => number | null,
): {
  exchangeData: ExchangeAllocation[];
  regionData: RegionAllocation[];
  totalValue: number;
  /** Currencies with no rate into the display currency, so their holdings could not be placed. */
  missingCurrencies: string[];
  /** Holdings left out of `totalValue` because they could not be priced or converted. */
  excludedCount: number;
} {
  const exchangeMap = new Map<
    string,
    { country: string; region: string; count: number; value: number }
  >();
  // A missing price or rate leaves a holding out of every figure below, so
  // `totalValue` is a subtotal whenever either happens -- tracked here so the
  // report can mark it instead of presenting the smaller number as the whole.
  const missing = new Set<string>();
  let excludedCount = 0;

  holdings.forEach((h) => {
    const exchange = securityExchangeMap.get(h.securityId) || 'Unknown';
    const info = EXCHANGE_TO_REGION[exchange] || { country: 'Other', region: 'Other' };
    // Two ways this holding cannot be placed: the server could not price it
    // (`marketValue` null) or there is no rate into the display currency. `?? 0`
    // used to include it as a zero, which re-weighted every other region.
    if (h.marketValue === null || h.marketValue === undefined) {
      excludedCount += 1;
      return;
    }
    const marketValue = convertToDefault(h.marketValue, h.currencyCode);
    if (marketValue === null) {
      missing.add(h.currencyCode);
      excludedCount += 1;
      return;
    }

    const existing =
      exchangeMap.get(exchange) || {
        country: info.country,
        region: info.region,
        count: 0,
        value: 0,
      };
    exchangeMap.set(exchange, {
      ...existing,
      count: existing.count + 1,
      value: existing.value + marketValue,
    });
  });

  const total = Array.from(exchangeMap.values()).reduce((sum, v) => sum + v.value, 0);

  const exchangeData: ExchangeAllocation[] = Array.from(exchangeMap.entries())
    .map(([exchange, data]) => ({
      exchange,
      country: data.country,
      region: data.region,
      count: data.count,
      marketValue: data.value,
      percentage: total > 0 ? (data.value / total) * 100 : 0,
    }))
    .sort((a, b) => b.marketValue - a.marketValue);

  const regionMap = new Map<string, { value: number; count: number }>();
  exchangeData.forEach((e) => {
    const existing = regionMap.get(e.region) || { value: 0, count: 0 };
    regionMap.set(e.region, {
      value: existing.value + e.marketValue,
      count: existing.count + e.count,
    });
  });

  const regionData: RegionAllocation[] = Array.from(regionMap.entries())
    .map(([region, data]) => ({
      region,
      marketValue: data.value,
      percentage: total > 0 ? (data.value / total) * 100 : 0,
      count: data.count,
      color: REGION_COLOURS[region] || chartColors.axis,
    }))
    .sort((a, b) => b.marketValue - a.marketValue);

  return {
    exchangeData,
    regionData,
    totalValue: total,
    missingCurrencies: [...missing],
    excludedCount,
  };
}
