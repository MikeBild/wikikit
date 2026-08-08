/**
 * Every path prefix `bun run dev:cockpit` forwards to a locally running WikiKit.
 *
 * The dev server has to look like the API origin to the browser: same origin so
 * the session cookie applies, and so the same-origin rule on cookie-authenticated
 * writes is satisfied. Anything the console fetches that is NOT proxied is
 * answered by Vite instead — with the SPA fallback, so the console gets a 200
 * full of HTML where it expected JSON, and the card that asked renders its error
 * state on every single dev run. That is a papercut nobody reports because it
 * looks like the page is simply broken.
 *
 * Its own module, and not a literal inside `vite.config.ts`, so that
 * `test/unit/cockpit-navigation.test.ts` can hold this list against the paths
 * the navigation table declares the console reaches. Importing the vite config
 * to read one array would pull the React and Tailwind plugins into a unit test.
 *
 * Prefixes, matched as whole path segments: `/v1` covers `/v1/spaces/…`, and
 * `/.well-known` covers the service descriptor the System page opens with.
 * `/review` is the odd one out — nothing fetches it, but it is the public
 * proposal review page the console hands out as a URL, and a link an operator
 * copies out of dev has to open.
 */
export const DEV_PROXY_PATHS = [
  '/v1',
  '/openapi.json',
  '/health',
  '/ready',
  '/llms.txt',
  '/review',
  '/.well-known',
] as const

/** True when the dev server forwards `path` rather than answering it with the shell. */
export function isProxied(path: string): boolean {
  return DEV_PROXY_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}
