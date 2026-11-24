// The Compare store relies on POSIX owner and mode checks, directory fsync and O_NOFOLLOW. Windows has none of
// them, so Compare refuses there at its entry points instead of running with weaker checks. Walkr does not
// support Windows.
export const POSIX_ONLY_CODE = "PLATFORM_UNSUPPORTED";
export const POSIX_ONLY_MESSAGE = "Compare needs Linux or macOS. Walkr does not support Windows.";

/** The refusal message on Windows, else null. `platform` is injectable for tests. */
export function posixOnlyRefusal(platform = process.platform) {
  return platform === "win32" ? POSIX_ONLY_MESSAGE : null;
}
