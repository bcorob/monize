/**
 * The `security_prices.source` of a row the bond engine writes. A leaf module so
 * the securities layer can name it without importing the bond services (which
 * import it back).
 */
export const BOND_ENGINE_PRICE_SOURCE = "bond_engine";
