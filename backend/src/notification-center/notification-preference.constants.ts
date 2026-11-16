/**
 * The longest cooldown window the matrix accepts, in minutes (24h). A window
 * beyond a day suppresses so much it reads as "off" done wrong; 0 is the real
 * "off". Lives in this leaf module so both the DTO (`@Max`) and the service
 * (defensive clamp) import it without the DTO depending on the full service.
 */
export const THROTTLE_MAX_MINUTES = 1440;
