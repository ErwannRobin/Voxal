export interface PeerItemCompactProps {
  label: string;
  /** Self chip is taller (62px) with mic icon; others are flat (28px) */
  self?: boolean;
  talking?: boolean;
  /** Optional color for the label (anonymous Color Animal palette) */
  labelColor?: string;
}
