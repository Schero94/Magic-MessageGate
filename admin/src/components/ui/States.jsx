import { Box, Button, EmptyStateLayout, Flex, Loader } from '@strapi/design-system';
import { ArrowClockwise, WarningCircle } from '@strapi/icons';
import { useT } from '../../hooks/useT';
import { errorMessage } from '../../utils/apiError';

/**
 * Loading placeholder for a section body.
 *
 * @param {{ label?: string }} props - Accessible label.
 * @returns {JSX.Element} Loader.
 */
export const LoadingState = ({ label }) => {
  const t = useT();
  return (
    <Flex justifyContent="center" padding={8}>
      <Loader>{label || t('common.loading', 'Loading…')}</Loader>
    </Flex>
  );
};

/**
 * Error state of a section with the translated reason and a retry button.
 *
 * @param {{ error: any, onRetry: () => void }} props - Props.
 * @returns {JSX.Element} Error.
 */
export const ErrorState = ({ error, onRetry }) => {
  const t = useT();
  return (
    <EmptyStateLayout
      hasRadius
      shadow="filterShadow"
      icon={<WarningCircle width="6.4rem" height="6.4rem" aria-hidden />}
      content={errorMessage(t, error)}
      action={
        <Button variant="secondary" startIcon={<ArrowClockwise />} onClick={onRetry}>
          {t('common.retry', 'Try again')}
        </Button>
      }
    />
  );
};

/**
 * Guiding empty state: what is missing and the one action that fixes it.
 *
 * @param {{ icon: JSX.Element, content: string, action?: JSX.Element }} props - Props.
 * @returns {JSX.Element} Empty state.
 */
export const EmptyState = ({ icon, content, action }) => (
  <Box>
    <EmptyStateLayout hasRadius shadow="filterShadow" icon={icon} content={content} action={action} />
  </Box>
);
