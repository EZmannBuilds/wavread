# WavRead

**Your music, translated into words.**

WavRead analyzes music on your own computer and turns it into measurements,
explanations, and readable documents — for you, or for any AI assistant.

- **Website:** https://wavread.vercel.app
- **Downloads:** [Releases](https://github.com/EZmannBuilds/wavread/releases)
- **Licence:** [EULA.md](EULA.md)
- **Third-party components:** [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)

This repository hosts WavRead's website source and release downloads. Update
1.4.7 also contains the review-only registered beta tester experience: public
pages stay account-free, while the tester dashboard uses Supabase Auth and RLS.

The site is deployed to Vercel. `./deploy.sh` is the production publishing
command and must only be run after separate approval. It runs these verification
steps and stages the built site plus the beta config API before publishing:

```sh
npm run check
npm test
npm run build
```

See [UPDATE_1.4.7.md](UPDATE_1.4.7.md),
[BETA_BACKEND.md](BETA_BACKEND.md), and
[WEB_DESIGN_SYSTEM.md](WEB_DESIGN_SYSTEM.md) before reviewing or configuring
the tester area. WavRead is a commercial product; its application source code
is not public.

© 2026 Erik Mann (EZmannBuilds). All rights reserved.
