# BBH Premier Events — Website

Static site (plain HTML/CSS, no build step). Hosted free on Netlify.

## Pages
- `index.html` — Home
- `weddings.html` — Weddings & Tents
- `corporate.html` — Corporate & Schools
- `rentals.html` — Rental catalog & prices
- `contact.html` — Quote form + online deposits (Stripe)
- `thank-you.html` — shown after the quote form is sent

## Launch checklist
- [ ] Buy domain
- [ ] Create GitHub account, put this folder in a repository
- [ ] Create Netlify account, connect the repository (auto-deploys on every change)
- [ ] Connect the domain in Netlify (Domain management → Add domain)
- [ ] Netlify → Forms → turn on email notifications for the "quote" form
- [ ] Create Stripe account, make 3 Payment Links, paste them into `contact.html`

## Placeholders still to fill in
Search the files for `[` to find them.
- Home: `[YEAR]` founded, 3 client testimonials, crew photo
- Corporate: insurance coverage amount, package prices, number of inflatables
- Rentals: Keder / backyard pole / double pole / chairs / linens / lighting / dance floor photos, linen colors, sailcloth size, stage price
- Contact: deposit amounts, balance terms, refund policy, 3 Stripe links
- Footer (all pages): license number

## Admin / back office (`/admin/`)
Orders, payments, delivery schedule and reports, at `https://<your-site>/admin/`.
- **Owner login** sees everything: Orders, Schedule, Reports, and can add phone/quote orders.
- **Crew login** only sees the Schedule (addresses, rentals, setup notes; no prices or payments) and can check off deliveries and pickups.
- Paid online bookings are pulled in from Stripe automatically when the admin is opened (or with "Check for new bookings").
- Orders are stored in Netlify Blobs (built in to Netlify, nothing to sign up for).

Setup, in Netlify → Site configuration → Environment variables:
- `ADMIN_PASSWORD`: owner password (use something long)
- `CREW_PASSWORD`: crew password
- `STRIPE_SECRET_KEY`: already set for checkout; the admin uses it to read bookings

Changing either password logs everyone out. Code: `admin/` (page), `netlify/functions/admin-api.mjs` + `netlify/lib/admin-core.mjs` (API).
`.claude/admin-test.html` is a local test bench (fake Stripe + in-memory storage) and is not deployed.

## Preview locally
Run `.claude/serve.ps1` in PowerShell, then open http://localhost:8080
