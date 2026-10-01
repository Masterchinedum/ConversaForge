/**
 * Course asset uploads: we never trust the client's Content-Type. The file's magic bytes decide the
 * type, and each purpose only accepts its own family (cover → image, VIDEO item → video, DOCUMENT → PDF).
 */

export type AssetPurpose = 'cover' | 'video' | 'document';

export const ASSET_LIMITS: Record<AssetPurpose, number> = {
  cover: 10 * 1024 * 1024,
  document: 50 * 1024 * 1024,
  video: 200 * 1024 * 1024,
};

export function sniffMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  const hex = buf.subarray(0, 12).toString('hex');
  if (hex.startsWith('89504e470d0a1a0a')) return 'image/png';
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('47494638')) return 'image/gif';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (hex.startsWith('1a45dfa3')) return 'video/webm';
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('ascii');
    return brand.startsWith('qt') ? 'video/quicktime' : 'video/mp4';
  }
  return null;
}

export function mimeAllowedFor(purpose: AssetPurpose, mime: string): boolean {
  switch (purpose) {
    case 'cover':
      return ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime);
    case 'video':
      return ['video/mp4', 'video/webm', 'video/quicktime'].includes(mime);
    case 'document':
      return mime === 'application/pdf';
  }
}

export function safeFileName(name: string | undefined | null, fallback: string): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^\w.\- ]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
  return cleaned || fallback;
}
