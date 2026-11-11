import { Box, Flex, Tabs } from '@strapi/design-system';
import { ChartPie, Cog, Feather, Message, Phone, User } from '@strapi/icons';
import { Page } from '@strapi/strapi/admin';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';

import { SectionTabsList } from '../components/ui/SectionTabsList';
import { useMgRBAC } from '../hooks/useMgRBAC';
import { useT } from '../hooks/useT';
import { menuPermissions } from '../permissions';
import { PLUGIN_ID } from '../pluginId';
import { AccountsPage } from './Accounts';
import { AnalyticsPage } from './Analytics';
import { ContactsPage } from './Contacts';
import { MessagesPage } from './Messages';
import { SettingsPage } from './Settings';
import { TemplatesPage } from './Templates';
import { TemplateEditorPage } from './Templates/TemplateEditor';

const BASE = `/plugins/${PLUGIN_ID}`;

/** Section order: daily work first (messages), setup last (accounts, settings). */
export const SECTIONS = [
  { value: 'messages', path: '', Icon: Message, group: 'messages' },
  { value: 'templates', path: 'templates', Icon: Feather, group: 'templates' },
  { value: 'contacts', path: 'contacts', Icon: User, group: 'contacts' },
  { value: 'accounts', path: 'accounts', Icon: Phone, group: 'accounts' },
  { value: 'analytics', path: 'analytics', Icon: ChartPie, group: 'analytics' },
  { value: 'settings', path: 'settings', Icon: Cog, group: 'settings' },
];

/**
 * @param {string} pathname - Current path.
 * @returns {string} Active section.
 */
export const activeSection = (pathname) => {
  const rest = pathname.split(BASE)[1] || '';
  const first = rest.replace(/^\/+/, '').split('/')[0];
  return SECTIONS.find((s) => s.path === first)?.value || 'messages';
};

/**
 * Plugin page: one Strapi page with a section tab strip (Magic Mail
 * pattern) above the native header of the active section. The template
 * editor is a full page without tabs.
 *
 * @returns {JSX.Element} App.
 */
const App = () => {
  const t = useT();
  const location = useLocation();
  const navigate = useNavigate();
  const rbac = useMgRBAC();
  const isEditor = /\/templates\/(new|[a-z0-9]{6,32})\/?$/.test(location.pathname);

  const labels = {
    messages: t('nav.messages', 'Messages'),
    templates: t('nav.templates', 'Templates'),
    contacts: t('nav.contacts', 'Contacts'),
    accounts: t('nav.accounts', 'Accounts'),
    analytics: t('nav.analytics', 'Analytics'),
    settings: t('nav.settings', 'Settings'),
  };
  const visible = SECTIONS.filter((s) => rbac[s.group]?.read);
  const active = activeSection(location.pathname);

  if (rbac.isLoading) return <Page.Loading />;
  if (!visible.length) return <Page.NoPermissions />;

  return (
    <Page.Protect permissions={menuPermissions}>
      <Page.Main aria-label={isEditor ? undefined : labels[active]}>
        {isEditor ? (
          <Routes>
            <Route path="templates/:id" element={<TemplateEditorPage />} />
          </Routes>
        ) : (
          <>
            <Page.Title>{`${labels[active]} | MessageGate`}</Page.Title>
            <Box paddingLeft={10} paddingRight={10} paddingTop={6}>
              <Tabs.Root
                value={active}
                onValueChange={(value) => navigate(`${BASE}/${SECTIONS.find((s) => s.value === value).path}`)}
              >
                <SectionTabsList
                  value={active}
                  label={t('nav.label', 'MessageGate sections')}
                  previousLabel={t('nav.previous', 'Show previous sections')}
                  nextLabel={t('nav.next', 'Show more sections')}
                >
                  {visible.map(({ value, Icon }) => (
                    <Tabs.Trigger key={value} value={value}>
                      <Flex gap={2} alignItems="center">
                        <Icon aria-hidden focusable={false} />
                        {labels[value]}
                      </Flex>
                    </Tabs.Trigger>
                  ))}
                </SectionTabsList>
              </Tabs.Root>
            </Box>
            <Routes>
              <Route
                index
                element={rbac.messages.read ? <MessagesPage /> : <Navigate to={`${BASE}/${visible[0].path}`} replace />}
              />
              <Route path="templates" element={rbac.templates.read ? <TemplatesPage /> : <Page.NoPermissions />} />
              <Route path="contacts" element={rbac.contacts.read ? <ContactsPage /> : <Page.NoPermissions />} />
              <Route path="accounts" element={rbac.accounts.read ? <AccountsPage /> : <Page.NoPermissions />} />
              <Route path="analytics" element={rbac.analytics.read ? <AnalyticsPage /> : <Page.NoPermissions />} />
              <Route path="settings" element={rbac.settings.read ? <SettingsPage /> : <Page.NoPermissions />} />
              <Route path="*" element={<Page.Error />} />
            </Routes>
          </>
        )}
      </Page.Main>
    </Page.Protect>
  );
};

export { App };
export default App;
