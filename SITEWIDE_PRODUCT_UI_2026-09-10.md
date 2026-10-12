# Site-wide product website UI

September 10, 2026. All 15 website pages now use the approved product design. This includes the old purchase page shown in Erik's screenshot, the account area and every supporting page. Published at https://wavread.com/ in deployment `dpl_EXAnCpZTtspF8J17tx3QA3AnWz4r` (https://wavread-ezrm0mqv6-lorehouse-team.vercel.app).

## Design and changes

The homepage sets the design: pale paper #f0f3f7, dark blue text #142039, a studio panel #18283f, mint #78c7c5, muted text #536175 and borders #ced5df. Space Grotesk carries headings; Inter carries body copy and controls. Supporting pages now reuse product.css and a shared pages.css layer over existing component styles. This preserves account component behavior while replacing the earlier dark page treatment.

Every page has the same product wordmark, header, Explore menu, purchase link and full footer navigation. The native menu works without JavaScript; its small script adds outside-click and Escape dismissal with focus return. Main navigation links point to real homepage sections, and all supporting destinations are reachable from the menu and footer, including on mobile.

- Purchase: a two-column offer and checkout layout, explicit $50 pricing, a shorter introduction, a white form panel and readable purchase terms.
- Guides, requirements, reports, privacy and licence: grouped sections, restrained spacing, readable tables, and an on-page contents list where useful. Tables with row labels stack on mobile.
- FAQ: expandable native disclosure rows with keyboard support and clear open/closed indicators.
- Sign-in and checkout return: the same visual shell, focused forms and actionable next steps.
- Dashboard: updated overview cards, report/download panels, tables, controls and feedback form. Backend setup wording now gives the visitor a useful retry/support path.
- Capture and 404: the same product design and navigation. Capture remains Coming soon. Nested missing URLs retain working root-relative recovery links.

The homepage listening experience remains intact. Personal contact information remains removed. No trial, pricing experiment, marketing analytics or campaign was added.

## Coverage and checks

Pages: homepage, buy, sign-in, dashboard, purchase-complete, how-it-works, documents, capture, agent, requirements, install, FAQ, privacy, EULA and 404.

- Syntax checks, all 43 automated tests, and the static build passed. Existing visual/navigation assertions were updated for the new shared design; payment, ownership and notification tests still pass.
- All 15 pages were inspected at 375, 768 and 1280 pixels: 45 page/viewport combinations, with no horizontal overflow or broken images and one main landmark each.
- Visual review covered the purchase page, guide reading layout, sign-in, mobile FAQ and full owner dashboard layout. The dashboard layout used a temporary offline fixture with fictional data and no scripts; it was removed before building/uploading. Its feedback controls and wide checksum table were checked at mobile width.
- Existing form markup and main content IDs were preserved. Payment, account, notification and audio scripts match their pre-redesign sources byte for byte. The shared navigation script is new.
- On the public site, purchase and sign-in forms became ready; invalid purchase input was rejected without navigation. The signed-out dashboard correctly required sign-in. The homepage Frequency tab and signup readiness worked, and nested 404 recovery retained the shared UI and loaded assets.
- All 15 live pages plus four shared CSS/JavaScript files matched the tested source byte for byte. The public crawl checked 57 same-origin URLs: 55 successful responses and two intentional 404 checks. No broken local references were found.
- The site's personal-email removal remains verified. No payments, sign-in emails, feedback submissions or notification signups were sent during this UI update.

This update verifies layout and the public/signed-out flows. It does not claim a newly completed paid transaction or an authenticated customer download. Earlier end-to-end signup/Stripe-handoff evidence remains recorded separately. The desktop binary and public build catalog were not changed.

## Source and evidence

Website source: ~/Developer/wavread-site. Changed: 15 HTML files, docs/pages.css, docs/js/navigation.js, the existing site tests and package syntax-check command. Source changes were synchronized with concurrent-edit guards. Upload staging contained no environment files or test fixtures.

Evidence: `audit-evidence/sitewide-live-checks.json`, `audit-evidence/sitewide-crawl.json`, `public-release-verification.json`. Local implementation/review staging: `/private/tmp/wavread-site-wide`.
