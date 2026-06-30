export interface ButtonProps {
  /** Visual hierarchy level */
  variant: 'primary' | 'secondary' | 'ghost';
  /** Size: default (13px/9px–16px) or small (12px/5px–12px) */
  size?: 'default' | 'sm';
  /** Stretches to full container width */
  fullWidth?: boolean;
  disabled?: boolean;
  children: string;
  onClick?: () => void;
}
