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

## Preview locally
Run `.claude/serve.ps1` in PowerShell, then open http://localhost:8080
