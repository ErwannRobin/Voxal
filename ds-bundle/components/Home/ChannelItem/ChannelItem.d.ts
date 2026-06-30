export interface ChannelItemProps {
  name: string;
  /** Comma-separated list of active member names */
  members?: string;
  /** Number of active members */
  count?: number;
  loading?: boolean;
  onJoin?: () => void;
}
