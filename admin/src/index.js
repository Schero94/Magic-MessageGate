import { Message } from '@strapi/icons';

import { menuPermissions } from './permissions';
import { PLUGIN_ID } from './pluginId';

const LOCALES = ['en', 'de', 'fr', 'es', 'pt'];

export default {
  register(app) {
    app.addMenuLink({
      to: `plugins/${PLUGIN_ID}`,
      icon: Message,
      intlLabel: { id: `${PLUGIN_ID}.plugin.name`, defaultMessage: 'MessageGate' },
      Component: () => import('./pages/App'),
      permissions: menuPermissions,
    });
    app.registerPlugin({ id: PLUGIN_ID, name: 'Magic MessageGate', isReady: true });
  },

  bootstrap() {},

  async registerTrads({ locales }) {
    return Promise.all(
      locales.map(async (locale) => {
        const lang = LOCALES.includes(locale) ? locale : 'en';
        try {
          const { default: data } = await import(`./translations/${lang}.json`);
          const prefixed = Object.fromEntries(Object.entries(data).map(([k, v]) => [`${PLUGIN_ID}.${k}`, v]));
          return { data: prefixed, locale };
        } catch {
          return { data: {}, locale };
        }
      })
    );
  },
};
