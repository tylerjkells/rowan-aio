/**
 * The sync hub built into this build: a Supabase project's address and its
 * publishable key. The key is public by design (every row and file in the
 * hub is guarded by row-level security, per signed-in person). Settings →
 * Sync can also point at another hub.
 */
export const BUILT_IN_HUB = {
  url: 'https://qjmrckbavboyenjzlywu.supabase.co',
  key: 'sb_publishable_swI7A0isdRHRwtbNS5PxAA_5jimkQbH'
}

/** where the phone app is published (GitHub Pages, from main; see .github/workflows/phone.yml) */
export const PHONE_APP_URL = 'https://tylerjkells.github.io/rowan-aio/'
