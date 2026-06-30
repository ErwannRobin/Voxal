export interface NoiseCardProps {
  value: string;
  title: string;
  /** Title prefix rendered in accent color */
  titleAccent?: string;
  description: string;
  checked?: boolean;
  name?: string; // radio group name
  onChange?: (value: string) => void;
}
