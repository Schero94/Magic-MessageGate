import { Badge } from '@strapi/design-system';
import { useT } from '../../hooks/useT';
import { APPROVAL_VARIANT, STATUS_VARIANT, approvalLabels, statusLabels } from '../../utils/channels';

/**
 * Message status badge.
 *
 * @param {{ status: string }} props - Status.
 * @returns {JSX.Element} Badge.
 */
export const MessageStatusBadge = ({ status }) => {
  const t = useT();
  return <Badge variant={STATUS_VARIANT[status] || 'neutral'}>{statusLabels(t)[status] || status}</Badge>;
};

/**
 * Template approval badge.
 *
 * @param {{ status: string }} props - Approval status.
 * @returns {JSX.Element} Badge.
 */
export const ApprovalBadge = ({ status }) => {
  const t = useT();
  return <Badge variant={APPROVAL_VARIANT[status] || 'neutral'}>{approvalLabels(t)[status] || status}</Badge>;
};

/**
 * WhatsApp reachability badge.
 *
 * @param {{ value: string }} props - 'ok' | 'unreachable' | 'unknown'.
 * @returns {JSX.Element} Badge.
 */
export const ReachabilityBadge = ({ value }) => {
  const t = useT();
  if (value === 'ok') return <Badge variant="success">{t('contacts.reach.ok', 'On WhatsApp')}</Badge>;
  if (value === 'unreachable')
    return <Badge variant="danger">{t('contacts.reach.unreachable', 'Not on WhatsApp')}</Badge>;
  return <Badge>{t('contacts.reach.unknown', 'WhatsApp unknown')}</Badge>;
};
