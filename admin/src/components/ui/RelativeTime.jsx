/* Mirrors plugin-io (strapi-community/plugin-io admin/src/components/ui/RelativeTime.jsx): native Strapi Design System pattern. Keep in sync. */
import { useState } from 'react';
import { FormattedRelativeTime, useIntl } from 'react-intl';

/**
 * Relative time ("2 minutes ago") in the admin language that keeps counting,
 * with the absolute date and time as tooltip.
 *
 * @param {{ value: string | number }} props - ISO timestamp or epoch milliseconds.
 * @returns {JSX.Element} Time.
 * @see https://formatjs.github.io/docs/react-intl/components#formattedrelativetime
 */
export const RelativeTime = ({ value }) => {
  const { formatDate } = useIntl();
  const [renderedAt] = useState(() => Date.now());
  const ms = typeof value === 'number' ? value : Date.parse(value);
  const iso = new Date(ms).toISOString();
  const seconds = Math.round((ms - renderedAt) / 1000);
  return (
    <time dateTime={iso} title={formatDate(ms, { dateStyle: 'medium', timeStyle: 'medium' })}>
      <FormattedRelativeTime value={seconds} numeric="auto" updateIntervalInSeconds={10} />
    </time>
  );
};
