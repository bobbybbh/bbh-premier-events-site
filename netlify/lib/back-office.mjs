// Builds the back office for a Netlify Function: Netlify Blobs storage + catalog file + pricing helpers.
import { getStore } from '@netlify/blobs';
import catalog from '../../data/catalog.json';
import shared from './shared.js';
import { createBackOffice } from './admin-core.mjs';

export function backOffice() {
  const blobs = getStore({ name: 'bbh-admin', consistency: 'strong' });
  const store = {
    get: key => blobs.get(key, { type: 'json' }),
    set: (key, value) => blobs.setJSON(key, value),
    delete: key => blobs.delete(key),
    list: async prefix => (await blobs.list({ prefix })).blobs.map(b => b.key)
  };
  const { quoteDelivery, totals, cents } = shared;
  return createBackOffice({ store, env: process.env, catalog, pricing: { quoteDelivery, totals, cents } });
}
