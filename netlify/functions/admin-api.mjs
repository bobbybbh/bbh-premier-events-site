// /api/admin/* — back-office API for the /admin page (logic lives in ../lib/admin-core.mjs).
// Needs ADMIN_PASSWORD (and optionally CREW_PASSWORD) set in Netlify environment variables.
// Orders are kept in Netlify Blobs (built-in storage, no extra account).
import { getStore } from '@netlify/blobs';
import catalog from '../../data/catalog.json';
import { createApi } from '../lib/admin-core.mjs';

export default async (req) => {
  const blobs = getStore({ name: 'bbh-admin', consistency: 'strong' });
  const store = {
    get: key => blobs.get(key, { type: 'json' }),
    set: (key, value) => blobs.setJSON(key, value),
    delete: key => blobs.delete(key),
    list: async prefix => (await blobs.list({ prefix })).blobs.map(b => b.key)
  };
  return createApi({ store, env: process.env, catalog })(req);
};

export const config = { path: ['/api/admin', '/api/admin/*'] };
