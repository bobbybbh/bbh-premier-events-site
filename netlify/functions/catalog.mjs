// GET /api/catalog[?date=YYYY-MM-DD] — rentals for the booking page, with how many are left on that date.
import { backOffice } from '../lib/back-office.mjs';

export default async (req) => backOffice().publicCatalog(req);

export const config = { path: '/api/catalog' };
