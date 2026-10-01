import { z } from 'zod';

/**
 * Cursor pagination used by every list endpoint.
 *   ?limit=25&cursor=<opaque>
 * Response: { data: T[], nextCursor: string | null }
 * The cursor is the base64url of the last row's id (rows ordered by createdAt desc, id desc).
 */
export const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});
export type PaginationQuery = z.infer<typeof PaginationQuery>;

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}
export function decodeCursor(cursor?: string): string | undefined {
  if (!cursor) return undefined;
  try {
    return Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
}

/** Prisma args for cursor pagination: fetch limit+1 to detect a next page. */
export function prismaPageArgs(q: PaginationQuery) {
  const id = decodeCursor(q.cursor);
  return {
    take: q.limit + 1,
    ...(id ? { cursor: { id }, skip: 1 } : {}),
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
  };
}

export function toPage<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  return { data, nextCursor: hasMore ? encodeCursor(data[data.length - 1]!.id) : null };
}
