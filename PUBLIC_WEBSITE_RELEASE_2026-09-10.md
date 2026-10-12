# Public product website — September 10, 2026

The approved local preview is now the product homepage. It features the real **What the Light Remembers v03** project, 16 supplied stems, saved measurements, and a user-initiated 3:20 MP3 player with seeking. `docs/product.css` and `docs/js/product.js` own the new homepage; the existing support, purchase, and account styles remain in `docs/site.css`.

Windows is explicitly coming soon, without a promised date. Direct DAW capture is coming soon; its page and supporting product documentation now describe the exported-audio workflow. This website release does not publish a desktop binary or change the build catalog. Software structured data still names the catalog's current 1.4.49 release. The separately verified 1.5.4 desktop build remains local.

## Notification signup

The form calls the `notification-signup` Edge Function in the existing WavRead Supabase project, `aodccnadwomafotizssk`. Platform JWT verification is enabled. The browser contains the project's public anon JWT solely for that gate; the service-role credential stays in Supabase's function environment.

`public.wavread_notification_signups` stores a normalized, unique email, the Windows request, the optional news/offers choice (unchecked by default), consent wording version, status, and timestamps. New entries are requests; ownership of the email is not verified. Existing owner accounts and purchases are never imported. Anonymous repeat submissions cannot overwrite preferences or reactivate an opt-out. Support handles preference changes and deletion.

The handler validates origin, content type, body size, email, and boolean consent; returns generic duplicate responses; and uses an atomic database transaction to limit requests to 10 per IP/hour and 3 per email/day. Short-lived counters use keyed digests, not raw IP addresses. RLS and grants deny browser access to both tables and to the internal recording function. No signup records are returned by the endpoint.

This release collects requests only. It sends no email or campaigns. Before sending campaigns, connect a delivery service such as Resend, implement confirmation and one-click unsubscribe, and include only the appropriate opted-in audience. Supabase stores the list; it is not the campaign sender.

Migration applied through Supabase MCP: `20260910200741_wavread_notification_signups`. The earlier preview draft was generated locally at `20260910195329`; the production file uses the actual hosted migration version.

## Deployment and verification

User instruction: “The site looks good. Make it public!”

- Vercel project: `lorehouse-team/wavread`, `prj_v26mcCGYfPNx8LzF8AbHU2LSbiiq`.
- Deployment: `dpl_64HLrKAz7QQzXHVFfVyvxeqKBzwP`.
- Candidate: https://wavread-qodfj0vd7-lorehouse-team.vercel.app
- Public: https://wavread.com/
- `npm run check`, all 37 `npm test` checks, and `npm run build` passed.
- Candidate homepage matched the release source byte for byte. Existing strict CSP retained; inline style attributes replaced by data attributes and external-script CSSOM updates.
- Account config loaded; MP3 returned 206 byte ranges. No environment files, database files, private paths, or privileged credentials entered the upload.
- Hosted SQL tests verified unique addresses, consent preservation, opt-out preservation, and limits inside a rolled-back transaction. Public table privileges and RPC access were explicitly denied.
- Security advisor's two new INFO notices report RLS without policies: intentional because these tables are server-only. Existing Auth warnings about leaked-password protection and MFA were outside this change. See [RLS notice](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy), [password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection), and [MFA](https://supabase.com/docs/guides/auth/auth-mfa).

Public browser verification and fixture cleanup are recorded in the release verification JSON after promotion.

## Full public-site audit completed — September 10, 2026

The requested double-check covered every public page, supporting/account routes, assets, forms and mobile navigation. Technical fixes are now public in deployment `dpl_CppRxExSpVGWEu4R2xtynD2VhMD6`. Final syntax/build checks and all **43 website tests** passed. **57 page/viewport combinations** had no remaining overflow or failed images; a 57-URL crawl found no broken local links (55 successful responses and two intentional 404 checks).

Fixed early form submission, timeout/retry behavior, nested 404 paths, a licence purchase fragment, licence formatting, stale capture instructions, privacy copy, and unverified payment-success wording. Verified real sample audio, seeking, chart keyboard controls, Windows signup persistence and cleanup, and the $50 Stripe handoff without paying or sending an email.

The existing licence's section 4 still understates app network requests. A concrete factual replacement is recorded for owner review in `~/Developer/wavread-site/PUBLIC_WEBSITE_AUDIT_2026-09-10.md`; the agreement and desktop licence were not silently rewritten. A completed payment, sign-in email and authenticated owner download were not tested. Campaign delivery remains future work. Website publication does not publish the desktop app.

Full report: [Public website audit](PUBLIC_WEBSITE_AUDIT_2026-09-10.md).

## Licence network wording corrected — September 10, 2026

Following the explicit request to fix the licence issue, section 4 now accurately describes local audio analysis, update checks/downloads, cached local lyric transcription, optional reports and attachments, and device linking, with a link to Privacy. Licence version 1.1 is effective 2026-09-10. The website Markdown and rendered page agree, and the desktop source licence has the same section 4 correction for future builds. Other sections in each source were preserved verbatim. Existing built app artifacts were not rewritten or distributed.

All 43 website tests and the static build passed. The live licence was verified in the browser and byte for byte against source. Production deployment: `dpl_6fnbjdAfghE3Tvkd4Pu4XvBipH57`, https://wavread-kub6cy2dc-lorehouse-team.vercel.app, aliased to https://wavread.com/. The previously recorded network-wording issue is resolved.

## Licence website UI and strategy records

September 10, 2026: the public licence now uses the homepage header, footer, logo, fonts and palette, with a readable legal text column. Licence 1.1 wording was preserved. All 43 website tests and build passed; 375/1280px browser checks found no overflow. Live HTML/CSS match source. Deployment `dpl_2G7PqT3uTt4jZbwdpkYntSX8pyPW` is public at https://wavread.com/.

The licence page is publicly readable before purchase/app use. The app separately renders its bundled licence through its shared UI at `/legal/eula`. Public addresses are support@wavread.com, noreply@wavread.com (FAQ sign-in sender), and erikmann509@gmail.com (licence contact); you@example.com is a placeholder. No address was replaced and no message was sent.

The supplied Word strategy was left unchanged as requested. Recommendations and verified launch status are documented in `~/Developer/soundscribe/LAUNCH_STRATEGY_NOTES_2026-09-10.md` and the WavRead vault's `Growth and Launch Strategy.md`. The strategy does not authorize campaigns, outreach, pricing changes, tracking or spending.


September 10, 2026 contact correction: Erik requested removal of his personal email. The licence now lists support@wavread.com. The address was replaced in the website and desktop licence sources, and the site was redeployed. All 15 live HTML pages were checked and contain no personal email; 43 tests passed. Deployment: `dpl_FW5gvPkHUiYgB4Uuukmp8HARRAfw`.


## Site-wide product UI published

September 10, 2026: all 15 public/account/support pages now share the homepage design, including the purchase page previously shown in the old dark UI. The update passed 43 automated checks and 45 responsive page checks; live files and navigation were verified. Full record: `~/Developer/wavread-site/SITEWIDE_PRODUCT_UI_2026-09-10.md`. Deployment: `dpl_EXAnCpZTtspF8J17tx3QA3AnWz4r`. No desktop release, payments or email sends occurred.
