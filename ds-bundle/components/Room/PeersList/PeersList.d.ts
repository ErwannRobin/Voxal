export interface PeersListProps {
  peers: Array<{
    id: string;
    label: string;
    self?: boolean;
    talking?: boolean;
    iceType?: 'host' | 'srflx' | 'relay';
  }>;
  /** Shows invite nudge when true (user is alone in room) */
  showInviteNudge?: boolean;
  onCopyInvite?: () => void;
}
