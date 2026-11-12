// Small inline icons (stroke follows currentColor).
type P = { className?: string };
const base = (path: React.ReactNode, { className = "h-4 w-4" }: P, view = "0 0 24 24") => (
  <svg viewBox={view} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    {path}
  </svg>
);
export const Plus = (p: P) => base(<path d="M12 5v14M5 12h14" />, p);
export const Folder = (p: P) => base(<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />, p);
export const Trash = (p: P) => base(<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3" />, p);
export const Gear = (p: P) => base(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>, p);
export const ArrowUp = (p: P) => base(<path d="M12 19V5M5 12l7-7 7 7" />, p);
export const Square = (p: P) => base(<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />, p);
export const Chevron = (p: P) => base(<path d="M6 9l6 6 6-6" />, p);
export const ChevronRight = (p: P) => base(<path d="M9 6l6 6-6 6" />, p);
export const Check = (p: P) => base(<path d="M5 12.5l4.5 4.5L19 7.5" />, p);
export const X = (p: P) => base(<path d="M6 6l12 12M18 6L6 18" />, p);
export const Search = (p: P) => base(<><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4-4" /></>, p);
export const Terminal = (p: P) => base(<><path d="M5 8l4 4-4 4M12 17h7" /></>, p);
export const File = (p: P) => base(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>, p);
export const Spark = (p: P) => base(<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6" />, p);
export const ImageIcon = (p: P) => base(<><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle cx="9" cy="10" r="1.6" /><path d="M20.5 15.5l-4.5-4.5-8.5 8.5" /></>, p);
// A pushpin: pin a conversation to the top of the sidebar.
export const Pin = (p: P) => base(<path d="M9 4h6l-1 6 3 3v1H7v-1l3-3-1-6zM12 14v6" />, p);
export const Pencil = (p: P) => base(<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zM13.5 6.5l4 4" />, p);
export const Chat = (p: P) => base(<path d="M5.5 5h13A1.5 1.5 0 0 1 20 6.5v8a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V16a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 5.5 5z" />, p);
export const Sidebar = (p: P) => base(<><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M9.5 4.5v15" /></>, p);
export const Spinner = ({ className = "h-3.5 w-3.5" }: P) => (
  <svg viewBox="0 0 24 24" className={`${className} animate-spin`} aria-hidden="true">
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" fill="none" />
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" fill="none" />
  </svg>
);
