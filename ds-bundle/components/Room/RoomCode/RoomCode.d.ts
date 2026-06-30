export interface RoomCodeProps {
  /** The room code / peer ID string */
  code: string;
  /** Called when the user clicks to copy */
  onCopy?: () => void;
}

export interface CopyToastProps {
  /** Message displayed in the toast */
  message?: string; // default "Link copied!"
  visible: boolean;
}
