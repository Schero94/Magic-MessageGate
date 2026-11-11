import { PLUGIN_ID } from '../pluginId';

/**
 * Prefixes a translation key with the plugin id.
 *
 * @param {string} id - Key such as `settings.title`.
 * @returns {string} Runtime id such as `magic-messagegate.settings.title`.
 */
export const getTranslation = (id) => `${PLUGIN_ID}.${id}`;
