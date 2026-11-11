import { Box, Flex } from '@strapi/design-system';
import { Layouts } from '@strapi/strapi/admin';

/**
 * Frame of each plugin section: native `Layouts.Header` (h1, subtitle,
 * primary action) above `Layouts.Content`, like Strapi's settings pages.
 *
 * @param {object} props - Props.
 * @param {string} props.title - Section title (h1).
 * @param {string} [props.subtitle] - Subtitle.
 * @param {import('react').ReactNode} [props.primaryAction] - Header action.
 * @param {import('react').ReactNode} [props.secondaryAction] - Secondary header action.
 * @param {import('react').ReactNode} [props.navigationAction] - Back link.
 * @param {boolean} [props.busy] - aria-busy while loading.
 * @param {import('react').ReactNode} props.children - Content.
 * @returns {JSX.Element} Section frame.
 */
export const SectionFrame = ({ title, subtitle, primaryAction, secondaryAction, navigationAction, busy, children }) => (
  <Box aria-busy={busy || undefined}>
    <Layouts.Header
      title={title}
      subtitle={subtitle}
      primaryAction={primaryAction}
      secondaryAction={secondaryAction}
      navigationAction={navigationAction}
    />
    <Layouts.Content>
      <Flex direction="column" alignItems="stretch" gap={6} minWidth={0}>
        {children}
      </Flex>
    </Layouts.Content>
  </Box>
);
