import { Main, Box, Typography } from '@strapi/design-system';
import { Layouts } from '@strapi/strapi/admin';
import { useIntl } from 'react-intl';

import { PLUGIN_ID } from '../pluginId';

/** Placeholder until the full admin UI lands (phase 3). */
const App = () => {
  const { formatMessage } = useIntl();
  return (
    <Main>
      <Layouts.Header
        title={formatMessage({ id: `${PLUGIN_ID}.plugin.name`, defaultMessage: 'MessageGate' })}
        subtitle={formatMessage({
          id: `${PLUGIN_ID}.plugin.subtitle`,
          defaultMessage: 'WhatsApp, Telegram and SMS messages with delivery tracking',
        })}
      />
      <Layouts.Content>
        <Box background="neutral0" padding={6} hasRadius shadow="tableShadow">
          <Typography variant="omega">
            {formatMessage({
              id: `${PLUGIN_ID}.placeholder`,
              defaultMessage: 'The server API is ready. The admin interface is coming soon.',
            })}
          </Typography>
        </Box>
      </Layouts.Content>
    </Main>
  );
};

export default App;
