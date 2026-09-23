// Host-side half of the token-saver-ui bundle. The client bundle is built by
// build.mjs into lib/client.js; this entry is what the Loader activates on the
// host, and it only needs to be a valid plugin (it registers no host services).
export const name = 'token-saver-ui'

/** @param {import('@deepseek-ai/cordis').Context} _ctx */
export function apply(_ctx) {
  // Intentionally empty: the UI registers client-side slots.
}
