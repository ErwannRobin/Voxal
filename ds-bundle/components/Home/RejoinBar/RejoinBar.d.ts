export interface RejoinBarProps {
  /** Room code of the last session */
  roomCode: string;
  onRejoin?: () => void;
  onDismiss?: () => void;
}
