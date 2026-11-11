import { Box, Flex, Typography } from '@strapi/design-system';
import { CheckCircle, Information, WarningCircle } from '@strapi/icons';

const ICONS = { success: CheckCircle, danger: WarningCircle, warning: WarningCircle, primary: Information };

/**
 * Persistent inline notice in DS colours (unlike DS Alert it has no close
 * button, for states that stay true until the cause is fixed).
 *
 * @param {object} props - Props.
 * @param {'primary' | 'success' | 'warning' | 'danger'} [props.variant] - Tone.
 * @param {string} [props.title] - Bold first line.
 * @param {import('react').ReactNode} props.children - Text.
 * @param {import('react').ReactNode} [props.action] - Action below the text.
 * @param {'status' | 'alert'} [props.role] - Live-region role when it appears after an action.
 * @returns {JSX.Element} Notice.
 */
export const Notice = ({ variant = 'primary', title, children, action, role }) => {
  const Icon = ICONS[variant] || Information;
  return (
    <Box
      role={role}
      background={`${variant}100`}
      borderColor={`${variant}200`}
      hasRadius
      paddingTop={4}
      paddingBottom={4}
      paddingLeft={5}
      paddingRight={5}
    >
      <Flex gap={3} alignItems="flex-start">
        <Box paddingTop={1} shrink={0}>
          <Icon fill={`${variant}600`} aria-hidden />
        </Box>
        <Flex direction="column" alignItems="flex-start" gap={2} minWidth={0}>
          {title ? (
            <Typography fontWeight="bold" textColor="neutral800">
              {title}
            </Typography>
          ) : null}
          <Typography textColor="neutral800">{children}</Typography>
          {action}
        </Flex>
      </Flex>
    </Box>
  );
};
