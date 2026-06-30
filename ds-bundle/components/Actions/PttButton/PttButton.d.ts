export interface PttButtonProps {
  /** Visual state of the button */
  state: 'idle' | 'active' | 'freehand';
  /** Default 80px; desktop breakpoint (≥640px) uses 96px automatically */
  size?: number;
  /** Icon displayed inside. Default: "🎙️" */
  emoji?: string;
  onPressStart?: () => void;
  onPressEnd?: () => void;
}
