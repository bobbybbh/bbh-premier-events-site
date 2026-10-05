// /api/admin/* — back-office API for the /admin page (logic lives in ../lib/admin-core.mjs).
// Needs ADMIN_PASSWORD (and optionally CREW_PASSWORD) set in Netlify environment variables.
// Orders and inventory are kept in Netlify Blobs (built-in storage, no extra account).
import { backOffice } from '../lib/back-office.mjs';

export default async (req) => backOffice().handle(req);

export const config = { path: ['/api/admin', '/api/admin/*'] };
