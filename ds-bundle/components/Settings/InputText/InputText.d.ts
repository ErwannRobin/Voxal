export interface InputTextProps {
  value?: string;
  placeholder?: string;
  type?: 'text' | 'password';
  /** Shows an × clear button on the right */
  clearable?: boolean;
  onClear?: () => void;
  onChange?: (value: string) => void;
}
