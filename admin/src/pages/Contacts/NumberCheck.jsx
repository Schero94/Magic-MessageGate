import { Flex, Typography } from '@strapi/design-system';

import { RelativeTime } from '../../components/ui/RelativeTime';
import { ToneBadge } from '../../components/ui/StatusBadge';
import { useT } from '../../hooks/useT';

/**
 * Learned RCS capability (nothing shown while unknown).
 *
 * @param {{value?: string}} props - Props.
 * @returns {JSX.Element|null} Badge.
 */
export const RcsBadge = ({ value }) => {
  const t = useT();
  if (value === 'capable') return <ToneBadge tone="success">{t('contacts.rcs.capable', 'RCS')}</ToneBadge>;
  if (value === 'not_capable') return <ToneBadge tone="neutral">{t('contacts.rcs.notCapable', 'No RCS')}</ToneBadge>;
  return null;
};

/**
 * Line type, HLR status and when it was checked.
 *
 * @param {{contact: object}} props - Props.
 * @returns {JSX.Element} Cell content.
 */
export const NumberCheck = ({ contact }) => {
  const t = useT();
  const active = contact.line?.active;
  return (
    <Flex direction="column" alignItems="flex-start" gap={1}>
      <Flex gap={2} wrap="wrap">
        {contact.lineType ? <ToneBadge tone="neutral">{contact.lineType}</ToneBadge> : null}
        {active === true ? <ToneBadge tone="success">{t('contacts.line.active', 'Assigned')}</ToneBadge> : null}
        {active === false ? <ToneBadge tone="danger">{t('contacts.line.inactive', 'Not assigned')}</ToneBadge> : null}
        {active == null && !contact.lineType ? (
          <Typography textColor="neutral600">{t('contacts.line.unchecked', 'Not checked')}</Typography>
        ) : null}
      </Flex>
      {contact.line?.checkedAt ? (
        <Typography variant="pi" textColor="neutral600">
          {t('contacts.line.checked', 'Checked')} <RelativeTime value={contact.line.checkedAt} />
        </Typography>
      ) : null}
    </Flex>
  );
};
