/**
 * team/utils.ts - Shared utilities for the team pipeline
 */

/** Generate a URL-friendly slug from text */
export function slugify(text: string, maxLen: number = 50): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, maxLen)
    .replace(/-$/, "");
}

/** Format a date as YYYY-MM-DD */
export function datePrefix(isoDate: string): string {
  return isoDate.slice(0, 10);
}
