// POST /.netlify/functions/create-checkout -> { url } (Stripe Checkout)
// Prices and availability come from the live inventory; rentals are held while the customer pays.
// Requires the STRIPE_SECRET_KEY environment variable, set in Netlify (never in this code).
import { backOffice } from '../lib/back-office.mjs';

export default async (req) => backOffice().checkout(req);
