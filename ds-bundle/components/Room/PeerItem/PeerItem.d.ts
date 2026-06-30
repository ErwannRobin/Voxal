export interface PeerItemProps {
  /** Display name */
  label: string;
  /** Whether this is the local user's own row */
  self?: boolean;
  /** Whether this peer is currently transmitting audio */
  talking?: boolean;
  /** ICE connection type — drives dot color */
  iceType?: 'host' | 'srflx' | 'relay';
  /** Optional role tag shown in italic after the name */
  role?: 'host' | 'deputy';
  /** Short peer UUID for identification */
  uuid?: string;
  /** WebRTC stat badges to display below the name */
  stats?: Array<{ label: string; variant: 'neutral' | 'direct' | 'stun' | 'relay' | 'warn' }>;
}
