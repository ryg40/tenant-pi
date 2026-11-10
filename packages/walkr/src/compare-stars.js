// The session rating. The record saves a whole number from 1 to 10. The page shows it as five stars:
// one point is one half star, so 7 shows as 3.5 stars. Shared by the store and the page.
export const RATING_MIN = 1;
export const RATING_MAX = 10;

export const isRating = (value) => Number.isInteger(value) && value >= RATING_MIN && value <= RATING_MAX;

/** "3.5 of 5 stars" for 7. "Not rated" for no rating. */
export function starsLabel(value) {
  return isRating(value) ? `${value / 2} of 5 stars` : "Not rated";
}

/** A short text form for lists: "★★★½" for 7, "" for no rating. */
export function starsText(value) {
  return isRating(value) ? "★".repeat(Math.floor(value / 2)) + (value % 2 ? "½" : "") : "";
}

/** The next rating for an arrow key: -1 or +1 half star, inside the limits. No rating starts at the lowest. */
export function stepRating(value, by) {
  return isRating(value) ? Math.min(RATING_MAX, Math.max(RATING_MIN, value + by)) : RATING_MIN;
}
