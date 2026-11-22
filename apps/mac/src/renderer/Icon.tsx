/**
 * Inline SVG icons (24×24 grid, stroked). Drawn for this app; the approved
 * prototype's icon style is a 1.8px rounded stroke, which these follow.
 */
export type IconName =
  | 'library'
  | 'plus'
  | 'search'
  | 'filter'
  | 'grid'
  | 'list'
  | 'back'
  | 'history'
  | 'close'
  | 'alert'
  | 'check'
  | 'diff'
  | 'copy'
  | 'merge'
  | 'doc'
  | 'image'
  | 'video'
  | 'mixed'
  | 'offline'
  | 'assets'
  | 'imports'
  | 'settings'
  | 'upload'
  | 'link'
  | 'folder'
  | 'key'
  | 'retry'
  | 'audio'
  | 'file'
  | 'api'
  | 'refresh'
  | 'fileMissing'
  | 'phone'
  | 'spark'
  | 'expandText'
  | 'shortenText'
  | 'tone'
  | 'undo'
  | 'send'
  | 'lines'
  | 'prompt'
  | 'language'
  | 'sidebar'
  | 'appearance'
  | 'server'
  | 'info'
  | 'chevronDown'
  | 'chevronUp'
  | 'chevronRight'
  | 'tag'
  | 'trash'
  | 'pulse'
  | 'inbox'
  | 'more';

const PATHS: Readonly<Record<IconName, readonly string[]>> = {
  library: ['M4 7.5 12 3l8 4.5-8 4.5Z', 'M4 12.5l8 4.5 8-4.5', 'M4 17l8 4 8-4'],
  plus: ['M12 5v14', 'M5 12h14'],
  more: [
    'M4.8 12a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0',
    'M10.8 12a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0',
    'M16.8 12a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0',
  ],
  inbox: ['M3 13h5l1.5 3h5L16 13h5', 'M5.5 5h13L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Z'],
  sidebar: ['M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z', 'M9 4v16'],
  appearance: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M12 3v18'],
  server: ['M4 5h16v6H4Z', 'M4 13h16v6H4Z', 'M8 8h.01', 'M8 16h.01'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 11v5', 'M12 8h.01'],
  chevronDown: ['m6 9 6 6 6-6'],
  chevronUp: ['m6 15 6-6 6 6'],
  chevronRight: ['m9 6 6 6-6 6'],
  tag: ['M3 12V4h8l9 9-8 8Z', 'M7.5 8h.01'],
  pulse: ['M5 12h3l2-6 4 12 2-6h3'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13', 'M10 11v6', 'M14 11v6'],
  search: ['M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Z', 'm20 20-4.8-4.8'],
  filter: ['M4 6h16', 'M7 12h10', 'M10 18h4'],
  grid: ['M4 4h7v7H4Z', 'M13 4h7v7h-7Z', 'M4 13h7v7H4Z', 'M13 13h7v7h-7Z'],
  list: ['M8 6h12', 'M8 12h12', 'M8 18h12', 'M4 6h.01', 'M4 12h.01', 'M4 18h.01'],
  back: ['M15 5l-7 7 7 7'],
  history: ['M3.5 12a8.5 8.5 0 1 0 2.5-6', 'M3.5 4v4h4', 'M12 7.5V12l3 2'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  alert: ['M12 3.5 2.5 20h19Z', 'M12 10v4.5', 'M12 17.5h.01'],
  check: ['m5 12.5 4.5 4.5L19 7'],
  diff: ['M8 4v16', 'M16 4v16', 'M4 9h8', 'M12 15h8'],
  copy: ['M9 9h11v11H9Z', 'M15 9V4H4v11h5'],
  merge: ['M6 3v5a7 7 0 0 0 7 7h5', 'm15 12 3 3-3 3', 'M6 21v-6'],
  doc: ['M6 3h8l4 4v14H6Z', 'M14 3v4h4', 'M9 12h6', 'M9 16h6'],
  image: ['M4 5h16v14H4Z', 'M9 10.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z', 'm20 15-5-5-9 9'],
  video: ['M4 6h11v12H4Z', 'm15 10 5-3v10l-5-3'],
  mixed: ['M4 4h7v7H4Z', 'M13 13h7v7h-7Z', 'M13 4h7', 'M13 8h7', 'M4 16h7', 'M4 20h7'],
  assets: ['M3 4h18v16H3Z', 'M9 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z', 'm21 16-5-5-9 9'],
  imports: ['M12 3v12', 'm7 10 5 5 5-5', 'M4 19h16'],
  settings: [
    'M4 6h10',
    'M18 6h2',
    'M4 12h4',
    'M12 12h8',
    'M4 18h12',
    'M16 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
    'M10 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
    'M18 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  ],
  upload: ['M12 21V9', 'm7 14 5-5 5 5', 'M4 4h16'],
  link: [
    'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1',
    'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  ],
  folder: ['M3 6h6l2 2h10v11H3Z'],
  key: ['M8 19a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'm11 12 9-9', 'm17 6 3 3'],
  retry: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4v7h-7'],
  audio: [
    'M9 18V6l11-2v12',
    'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    'M17 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  ],
  file: ['M6 3h8l4 4v14H6Z', 'M14 3v4h4'],
  api: ['m8 8-4 4 4 4', 'm16 8 4 4-4 4'],
  refresh: [
    'M4 12a8 8 0 0 1 14-5.3L20 9',
    'M20 4v5h-5',
    'M20 12a8 8 0 0 1-14 5.3L4 15',
    'M4 20v-5h5',
  ],
  fileMissing: ['M14 3H6v18h12V7Z', 'M14 3v4h4', 'm10 12 4 4', 'm14 12-4 4'],
  phone: ['M7 2h10v20H7Z', 'M11 18h2'],
  spark: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z'],
  expandText: ['M4 6h16', 'M4 11h16', 'M4 16h9', 'M18 14v6', 'M15 17h6'],
  shortenText: ['M4 6h16', 'M4 11h10', 'M15 17h6'],
  tone: ['M5 5h14v10H10l-5 4Z', 'M9 10h.01', 'M12 10h.01', 'M15 10h.01'],
  undo: ['M9 14 4 9l5-5', 'M4 9h11a5 5 0 0 1 0 10h-3'],
  send: ['M5 12h14', 'M13 6l6 6-6 6'],
  lines: ['M4 7h16', 'M4 12h16', 'M4 17h10'],
  // A prompt: a command chevron and a line to type on (QC-075).
  prompt: ['M4 6h16v12H4Z', 'M7.5 10l2.5 2-2.5 2', 'M12 14h4.5'],
  // 輸出語言 (QC-075): 文 and A.
  language: [
    'M3 5h10',
    'M8 3v2',
    'M5 5c1 4 4 7 8 8',
    'M11 5c-1 4-4 7-8 8',
    'M13 20l4-9 4 9',
    'M14.5 17h5',
  ],
  offline: [
    'M3 3l18 18',
    'M8.5 16.5a5 5 0 0 1 7 0',
    'M5 12.5a10 10 0 0 1 4-2.3',
    'M12 20h.01',
    'M15 10.3a10 10 0 0 1 4 2.2',
  ],
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
