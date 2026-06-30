export interface ThemeToggleProps {
  value: 'dark' | 'light' | 'system';
  onChange?: (theme: 'dark' | 'light' | 'system') => void;
}
