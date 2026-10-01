import type { SVGProps } from 'react';

/** Small stroke icons for the scenario screens (24×24 grid, inherit color). */
const PATHS = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1v-9.5Z',
  back: 'M19 12H5m6-6-6 6 6 6',
  chat: 'M4 5h16v11H8l-4 4V5Z',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  panel: 'M4 4h16v16H4zM9 4v16',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  arrowsOut: 'M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7',
  doc: 'M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7',
  code: 'M9 8l-4 4 4 4M15 8l4 4-4 4',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  rocket: 'M5 15c-1 1-2 4-2 6 2 0 5-1 6-2M9 15l-3-3 4-6c3-4 8-4 11-4 0 3 0 8-4 11l-6 4-2-2Zm6-6h.01',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 5 5',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7l1-8Z',
  stop: 'M7 7h10v10H7z',
  arrowUp: 'M12 19V5m-6 6 6-6 6 6',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  checkCircle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-4-9 3 3 5-6',
  wand: 'M15 4V2M15 10V8M11 6H9M21 6h-2M4 20 16 8M17.5 3.5l1 1M12.5 3.5l-1 1',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  type: 'M5 6V4h14v2M12 4v16M9 20h6',
  layers: 'M12 3 2 8l10 5 10-5-10-5ZM2 13l10 5 10-5M2 17l10 5 10-5',
  sparkles: 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3ZM19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14Z',
  clipboard: 'M9 4h6v3H9zM7 5H5v16h14V5h-2M9 13l2 2 4-4',
  share: 'M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm12 7a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8.6 13.5l6.8 4M15.4 6.5l-6.8 4',
  play: 'M7 4v16l13-8L7 4Z',
  pencil: 'M4 20h4L19 9l-4-4L4 16v4ZM14 6l4 4',
  more: 'M12 6h.01M12 12h.01M12 18h.01',
  phone: 'M5 4h4l2 5-3 2a11 11 0 0 0 5 5l2-3 5 2v4a2 2 0 0 1-2 2A17 17 0 0 1 3 6a2 2 0 0 1 2-2Z',
  video: 'M3 7h12v10H3zM15 10l6-3v10l-6-3',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v5l3 2',
  download: 'M12 3v12m-5-5 5 5 5-5M4 21h16',
  undo: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = 'h-4 w-4', ...rest }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className} {...rest}>
      <path d={PATHS[name]} />
    </svg>
  );
}
