/** The test relay (server/ in test mode, started by playwright.config.ts): port
 *  8788, or TD_RELAY_PORT when that one's taken. */
export const RELAY_HOST = `localhost:${process.env.TD_RELAY_PORT ?? '8788'}`;
export const RELAY_URL = `http://${RELAY_HOST}`;
