import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * A case-insensitive "contains" test for list filters, built once per query:
 * the query is matched literally, and an empty one matches everything.
 */
export function textFilter(query: string): (text: string) => boolean {
  const q = query.trim()
  if (!q) return () => true
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  return (text) => re.test(text)
}
