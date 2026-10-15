import { failure } from "./errors.mjs";

// No `*` or `?`: an IAM StringLike pattern reads them as wildcards. No `/`, `{`, `}` or `:` either.
export const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function validateId(value) {
  if (typeof value !== "string" || !ID.test(value)) throw failure("config");
  return value;
}
