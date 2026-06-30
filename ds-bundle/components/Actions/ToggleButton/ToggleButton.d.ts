export interface ToggleButtonProps {
  active: boolean;
  label?: string; // displayed text, e.g. "ON" / "OFF"
  onClick?: () => void;
}
