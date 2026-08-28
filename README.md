# WavRead

**Your music, translated into words.**

WavRead analyzes music on your own computer and turns it into measurements,
explanations, and readable documents — for you, or for any AI assistant.

- **Website:** https://www.wavread.com
- **Downloads:** [Releases](https://github.com/EZmannBuilds/wavread/releases)
- **Licence:** [EULA.md](EULA.md)
- **Third-party components:** [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)

This repository hosts WavRead's website source and release downloads. Update
1.4.7 contains the registered beta tester experience: public pages stay
account-free, while the tester dashboard uses Supabase Auth and RLS. Web Update 1
adds the A1 Clinical Signal brand system without changing that architecture.
Web Update 2 adds the $5 Early Build: Stripe-checkout purchase, durable
ownership and entitlements, gated build downloads, linked devices, and the
account's own reports — see [WEB_UPDATE_2.md](WEB_UPDATE_2.md) and
[BETA_BACKEND.md](BETA_BACKEND.md).

The site is deployed to Vercel. `./deploy.sh` is the production publishing
command and must only be run after separate approval. It runs these verification
steps and stages the built site plus the beta config API before publishing:

```sh
npm run check
npm test
npm run build
```

See [WEB_UPDATE_1.md](WEB_UPDATE_1.md),
[UPDATE_1.4.7.md](UPDATE_1.4.7.md),
[BETA_BACKEND.md](BETA_BACKEND.md), and
[WEB_DESIGN_SYSTEM.md](WEB_DESIGN_SYSTEM.md) before reviewing or configuring
the tester area. WavRead is a commercial product; its application source code
is not public.

© 2026 Erik Mann (EZmannBuilds). All rights reserved.
