# WavRead 1.5.4 — Owner Release

Published 2026-09-10 at the owner's explicit request. Eligible owners download from https://wavread.com/dashboard. Apple Silicon, macOS 14+. Windows remains Coming soon.

The app-wide listening workspace is the default. Direct DAW capture is disabled in frozen public builds and marked Coming soon. File and supplied-stem analysis remain available. Analysis schema remains 2. The bundled EULA matches the public v1.1 licence and uses support@wavread.com.

## Release artifact

- File: WavRead-1.5.4.dmg
- SHA-256: `a2afe92d3c7f748759abf85c75de69ccd0b134662fdd777e5f5e2a0c1f615d38`
- Bytes: 137803586
- Private bucket/path: builds / early/1.5.4/WavRead-1.5.4.dmg
- Catalog build ID: 14; published=true; existing $50 price and entitlement rules retained.
- Developer ID signed; app and DMG notarized and stapled; Gatekeeper checks passed.
- App notarization: 7319bda1-1929-4799-b171-805ddfb831a5
- DMG notarization: 3f577eb2-8d30-467a-bac0-96d5246c023c

## Verification

Runtime sources matched the previously tested snapshot (24 passing suites). Final frozen executable passed isolated launch/import checks and all ten capture guards, even with the development opt-in environment variable set. Bundled EULA checked. Final app deep signature verified outside the restricted sandbox; sandbox signature inspection produced a false failure, resolved by normal-host verification.

The uploaded DMG was downloaded again through authenticated storage access and its SHA-256 matched. Bucket remains private; anonymous download requests were denied. The deployed download function still checks authenticated identity, active account, publication and has_build_access before signing a 60-second URL. Database eligibility checks confirmed owner access. No owner login email was sent or account impersonated; the signed-in browser flow was not exercised during this release.

Website JavaScript checks, 43 tests and static build passed. Dashboard, install guide and metadata now identify 1.5.4 and retain the shared product UI. Live current-build API and all 15 public HTML pages plus four shared assets verified against deployed sources, including current version references and absence of the personal email. The legacy GitHub announcement has no binary attachment.

The original dist/1.5.4-local artifact and its historical checks are preserved. Final artifact and evidence: dist/1.5.4-owner/. The source strategy DOCX remains unchanged.
