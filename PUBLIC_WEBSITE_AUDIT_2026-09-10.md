# Public website audit — September 10, 2026

The full public-site audit is complete and its technical fixes are deployed at https://wavread.com/. The licence content issue found during this audit was subsequently resolved; see the dated correction below. This audit does not certify a completed paid purchase or authenticated owner download.

Production deployment: `dpl_CppRxExSpVGWEu4R2xtynD2VhMD6` — https://wavread-egumo7b26-lorehouse-team.vercel.app

## Published fixes

- Repaired the licence page's broken purchase fragment and nested 404 asset/navigation paths. Recovery works from a deeply nested missing URL.
- Re-rendered the licence from the existing authoritative `EULA.md`, preserving its wording while fixing literal Markdown and fragmented paragraphs.
- Purchase, sign-in and notification forms start disabled until their handlers are ready. Purchase/sign-in use POST and prevent native navigation immediately, including while configuration is loading. Added timeouts, recoverable errors, and no-JavaScript guidance. An early submission cannot put an email address into a GET query string.
- Removed unverified payment-success claims from the static checkout-return page. It now explains the next step and says that opening the page alone does not confirm payment.
- Corrected product/privacy wording about update requests, lyric-model downloads, and optional reports.
- Updated the site's agent guide and downloadable operating instructions to label direct DAW capture Coming soon. Historical analysis can still be read; current users are directed to exported mixes and stems.

## Verification completed

- `npm run check`, **43 automated tests**, and `npm run build` passed on the final website source. Regression checks cover form readiness/failures, all internal fragments, nested 404 paths, truthful return-page copy, licence formatting, capture availability, notification validation/consent, and existing account behavior.
- Parsed all 15 root HTML files and their links, fragments, assets and CSS references. **57 unique same-origin URLs** were fetched: 55 returned 200 after redirects; the two deliberately missing test routes returned the expected 404. No broken local fragments or duplicate IDs were found. GitHub skill and Stripe privacy links both returned 200.
- **57 distinct page/viewport combinations** passed: 14 public/account routes at 375, 768, 1280 and 1920 pixels, plus the nested 404 at 375 pixels. No horizontal overflow or failed images remained after loading/fonts settled. Rechecked the corrected checkout-return heading at all three larger widths after deployment.
- Checked mobile navigation open/close, Escape handling, nested 404 recovery, analysis-tab keyboard focus/selection, real MP3 playback, listening links, seeking and pause. The featured song, its 16 supplied stems and saved analysis remain the approved example.
- Invalid purchase and sign-in addresses were rejected without navigation. The no-JavaScript purchase state remained disabled with support guidance. Opened an unpaid Stripe checkout using a fictitious example.com address and verified **WavRead / $50.00 / every 1.x update included**. No payment method was entered and no payment was submitted.
- Confirmed the signed-out dashboard displays the sign-in gate. No sign-in email was sent, and no authenticated customer's data was accessed.
- Submitted a Windows signup in the public browser, saw the success response, and verified its Supabase row had Windows requested, optional marketing false, and status requested. Deleted that exact test row afterward. The earlier publication's three signup fixtures were already removed. No campaign or notification email was sent.
- Verified eight final live HTML/JavaScript responses byte for byte against the tested build, including the homepage, purchase page, FAQ, return page, licence and all three changed form scripts. The final public alias resolves to the deployment above.
- No serverless error entries were returned by the production log query for the inspected 30-minute window. This is a bounded observation, not proof of every historical request.

## Licence network wording: original finding, subsequently resolved

Existing `EULA.md` section 4 describes the lyric-model download as the sole network exception and says the app collects no telemetry. The current app and Privacy page also describe update checks/downloads, optional reports and device linking. The website's licence was reformatted without silently changing the underlying agreement or its version/effective date. This inconsistency remains visible in the published agreement and should be reconciled with the licence supplied in the desktop release.

Proposed factual replacement for section 4's first two paragraphs, for owner review (not published):

> WavRead analyzes audio locally on your computer and does not upload the source audio for analysis. You do not need an app account to analyze audio. The app can check for updates and download an update when you request it. Lyric transcription downloads its model when first used and then runs locally. Optional problem reports and device linking send the information described in the Privacy page; reporting is off by default. Audio analysis works without a network connection once any model you choose to use is available locally.

This draft does not change licence ownership, payment, refund, liability or third-party terms. Review it together with the desktop licence version before adoption.

## Verification limits and release boundaries

- The full paid transaction → Stripe webhook → receipt → owner sign-in → entitled download journey was not completed. Checkout handoff, input validation and signed-out access controls were tested. One unpaid audit checkout session can expire normally.
- Signup collection is live. Confirmation, campaign delivery and one-click unsubscribe are not implemented; no campaign readiness is claimed. Optional news consent is separate from the Windows request.
- The external GitHub skill package is historical; the website now states current capture availability. This audit did not publish a new package to that repository.
- This deployment publishes website files only. It does not distribute the local 1.5.4 desktop build or change the existing public build catalog. The signed/notarized desktop release remains separate.
- No conversion improvement or cross-browser equivalence is claimed. Interactive checks used the available Chromium-based browser.

Evidence: `public-release-verification.json`, `audit-evidence/site-crawl.json`, and `audit-evidence/final-public-checks.json`.

## Licence network wording corrected — September 10, 2026

Following the explicit request to fix the licence issue, section 4 now accurately describes local audio analysis, update checks/downloads, cached local lyric transcription, optional reports and attachments, and device linking, with a link to Privacy. Licence version 1.1 is effective 2026-09-10. The website Markdown and rendered page agree, and the desktop source licence has the same section 4 correction for future builds. Other sections in each source were preserved verbatim. Existing built app artifacts were not rewritten or distributed.

All 43 website tests and the static build passed. The live licence was verified in the browser and byte for byte against source. Production deployment: `dpl_6fnbjdAfghE3Tvkd4Pu4XvBipH57`, https://wavread-kub6cy2dc-lorehouse-team.vercel.app, aliased to https://wavread.com/. The previously recorded network-wording issue is resolved.

## Licence website UI and strategy records

September 10, 2026: the public licence now uses the homepage header, footer, logo, fonts and palette, with a readable legal text column. Licence 1.1 wording was preserved. All 43 website tests and build passed; 375/1280px browser checks found no overflow. Live HTML/CSS match source. Deployment `dpl_2G7PqT3uTt4jZbwdpkYntSX8pyPW` is public at https://wavread.com/.

The licence page is publicly readable before purchase/app use. The app separately renders its bundled licence through its shared UI at `/legal/eula`. Public addresses are support@wavread.com, noreply@wavread.com (FAQ sign-in sender), and erikmann509@gmail.com (licence contact); you@example.com is a placeholder. No address was replaced and no message was sent.

The supplied Word strategy was left unchanged as requested. Recommendations and verified launch status are documented in `~/Developer/soundscribe/LAUNCH_STRATEGY_NOTES_2026-09-10.md` and the WavRead vault's `Growth and Launch Strategy.md`. The strategy does not authorize campaigns, outreach, pricing changes, tracking or spending.
