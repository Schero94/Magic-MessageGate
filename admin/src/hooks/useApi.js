import { useMemo } from 'react';
import { useFetchClient } from '@strapi/strapi/admin';
import { PLUGIN_ID } from '../pluginId';

const BASE = `/${PLUGIN_ID}`;

/**
 * Plugin admin API client on top of Strapi's `useFetchClient` (admin JWT,
 * JSON, abort on unmount). Every call resolves with the `data` member of the
 * server envelope and throws the useFetchClient error otherwise.
 *
 * @returns {{
 *   get: (path: string, params?: object) => Promise<any>,
 *   post: (path: string, body?: object) => Promise<any>,
 *   put: (path: string, body?: object) => Promise<any>,
 *   del: (path: string) => Promise<any>,
 * }} Client.
 */
export function useApi() {
  const client = useFetchClient();
  const { get, post, put, del } = client;
  return useMemo(
    () => ({
      get: async (path, params) => (await get(`${BASE}${path}`, params ? { params } : undefined)).data?.data,
      post: async (path, body = {}) => (await post(`${BASE}${path}`, body)).data?.data,
      put: async (path, body = {}) => (await put(`${BASE}${path}`, body)).data?.data,
      del: async (path) => (await del(`${BASE}${path}`)).data?.data,
    }),
    [get, post, put, del]
  );
}
