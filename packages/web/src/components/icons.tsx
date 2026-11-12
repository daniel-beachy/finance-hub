import type { ReactNode } from "react";

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const HomeIcon = () => (
  <Icon>
    <path d="M3.5 9.5 10 4l6.5 5.5V16a.5.5 0 0 1-.5.5h-3.5v-4.5h-5v4.5H4a.5.5 0 0 1-.5-.5z" />
  </Icon>
);
export const ListIcon = () => (
  <Icon>
    <path d="M6.5 5.5h10M6.5 10h10M6.5 14.5h10" />
    <path d="M3.4 5.5h.2M3.4 10h.2M3.4 14.5h.2" strokeWidth="2" />
  </Icon>
);
export const InboxIcon = () => (
  <Icon>
    <path d="M3.5 11 5.6 4.9a.6.6 0 0 1 .57-.4h7.66a.6.6 0 0 1 .57.4L16.5 11v4a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5z" />
    <path d="M3.5 11h3.6l.9 1.8h4l.9-1.8h3.6" />
  </Icon>
);
export const PieIcon = () => (
  <Icon>
    <path d="M10 3.5a6.5 6.5 0 1 0 6.5 6.5H10z" />
    <path d="M12.5 3.2a6.5 6.5 0 0 1 4.3 4.3h-4.3z" />
  </Icon>
);
export const TrendIcon = () => (
  <Icon>
    <path d="m3.5 14 4-4.5 3 2.5 6-7" />
    <path d="M12.5 5h4v4" />
  </Icon>
);
export const BankIcon = () => (
  <Icon>
    <path d="M3.5 8 10 4l6.5 4M4.5 16.5h11M5.5 8.5v5.5M8.5 8.5v5.5M11.5 8.5v5.5M14.5 8.5v5.5" />
  </Icon>
);
export const SunIcon = () => (
  <Icon>
    <circle cx="10" cy="10" r="3" />
    <path d="M10 3.5v1.2M10 15.3v1.2M3.5 10h1.2M15.3 10h1.2M5.4 5.4l.85.85M13.75 13.75l.85.85M5.4 14.6l.85-.85M13.75 6.25l.85-.85" />
  </Icon>
);
export const MoonIcon = () => (
  <Icon>
    <path d="M15.5 11.8A6 6 0 0 1 8.2 4.5a6 6 0 1 0 7.3 7.3z" />
  </Icon>
);
export const ChevronLeft = () => (
  <Icon>
    <path d="m12 5-5 5 5 5" />
  </Icon>
);
export const ChevronRight = () => (
  <Icon>
    <path d="m8 5 5 5-5 5" />
  </Icon>
);
export const FlagIcon = () => (
  <Icon>
    <path d="M5 17V4M5 4.5h9l-1.8 3 1.8 3H5" />
  </Icon>
);
export const CheckIcon = () => (
  <Icon>
    <path d="m4.5 10.5 3.5 3.5 7.5-8" />
  </Icon>
);
export const SearchIcon = () => (
  <Icon>
    <circle cx="9" cy="9" r="5" />
    <path d="m13 13 3.5 3.5" />
  </Icon>
);
