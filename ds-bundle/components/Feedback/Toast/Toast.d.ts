export interface ToastProps {
  message: string;
  icon?: string; // emoji, default "✅"
  visible: boolean;
  /** Duration before auto-hide in ms, default 1500 */
  duration?: number;
}
