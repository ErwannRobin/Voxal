export interface SettingsCardProps {
  /** Section title shown in the collapsible toggle button */
  title: string;
  /** Whether the card body is collapsed */
  collapsed?: boolean;
  children: React.ReactNode;
}

export interface SettingsFieldProps {
  label: string;
  helper?: string;
  /** Row layout (for toggle + label) */
  inline?: boolean;
  children: React.ReactNode;
}
