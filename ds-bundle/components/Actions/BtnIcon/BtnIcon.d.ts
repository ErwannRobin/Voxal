export interface BtnIconProps {
  /** Icon content — emoji string or SVG markup */
  icon: string;
  title: string;
  /** "leave" adds red hover; default adds accent hover */
  variant?: 'default' | 'leave';
  fontSize?: number; // px, default 22
  onClick?: () => void;
}
