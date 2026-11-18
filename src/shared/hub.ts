/**
 * The sync hub built into this build: a Supabase project's address and its
 * publishable key. The key is public by design (every row and file in the
 * hub is guarded by row-level security, per signed-in person). Empty until
 * the hub project exists; Settings → Sync can also point at another hub.
 */
export const BUILT_IN_HUB = {
  url: '',
  key: ''
}
