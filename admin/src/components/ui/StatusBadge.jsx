import { Badge } from '@strapi/design-system';
import { useT } from '../../hooks/useT';
import { APPROVAL_VARIANT, STATUS_VARIANT, approvalLabels, statusLabels } from '../../utils/channels';

/**
 * DS Badge with explicit theme tokens (tone100 background, tone700 text).
 * The default variant colours of DS 2.2.4 Badge measure below 4.5:1 for
 * warning and danger in light mode and primary and danger in dark mode;
 * these token pairs pass in both themes.
 *
 * @param {{ tone?: 'neutral' | 'primary' | 'secondary' | 'alternative' | 'success' | 'warning' | 'danger', children: import('react').ReactNode }} props - Props.
 * @returns {JSX.Element} Badge.
 */
export const ToneBadge = ({ tone = 'neutral', children }) => (
  <Badge backgroundColor={tone === 'neutral' ? 'neutral150' : `${tone}100`} textColor={`${tone}700`}>
    {children}
  </Badge>
);

/**
 * Message status badge.
 *
 * @param {{ status: string }} props - Status.
 * @returns {JSX.Element} Badge.
 */
export const MessageStatusBadge = ({ status }) => {
  const t = useT();
  return <ToneBadge tone={STATUS_VARIANT[status] || 'neutral'}>{statusLabels(t)[status] || status}</ToneBadge>;
};

/**
 * Template approval badge.
 *
 * @param {{ status: string }} props - Approval status.
 * @returns {JSX.Element} Badge.
 */
export const ApprovalBadge = ({ status }) => {
  const t = useT();
  return <ToneBadge tone={APPROVAL_VARIANT[status] || 'neutral'}>{approvalLabels(t)[status] || status}</ToneBadge>;
};

/**
 * WhatsApp reachability badge.
 *
 * @param {{ value: string }} props - 'ok' | 'unreachable' | 'unknown'.
 * @returns {JSX.Element} Badge.
 */
export const ReachabilityBadge = ({ value }) => {
  const t = useT();
  if (value === 'ok') return <ToneBadge tone="success">{t('contacts.reach.ok', 'On WhatsApp')}</ToneBadge>;
  if (value === 'unreachable')
    return <ToneBadge tone="danger">{t('contacts.reach.unreachable', 'Not on WhatsApp')}</ToneBadge>;
  return <ToneBadge>{t('contacts.reach.unknown', 'WhatsApp unknown')}</ToneBadge>;
};
