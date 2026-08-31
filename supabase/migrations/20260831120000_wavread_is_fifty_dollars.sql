-- WavRead costs $50.
--
-- The Early Launch is over as a framing: there is no beta, no pre-release, and
-- no promised future "stable build" at a second price. There is the build, and
-- it costs fifty dollars. The website says so; this makes the charge agree.
--
-- `builds.price_cents` is the only place a price exists. create-checkout reads
-- it and builds Stripe's `unit_amount` from it, and the browser sends only an
-- email — so changing this row changes what a customer is actually charged,
-- and nothing else can contradict it.
--
-- People who bought at $5 keep everything they were promised. Their
-- entitlements are unscoped (`build_version is null`), which already means
-- every build; nothing here touches `entitlements`, `purchases`, or
-- `accounts.free_updates`. A price change is not retroactive and must not
-- look like one.

-- The default mattered more than it looks. Any future build row inserted
-- without an explicit price silently became $5 — a landmine left by the
-- migration that introduced per-build pricing.
alter table public.builds alter column price_cents set default 5000;

-- Scoped by version rather than by id: serial ids differ on a branch database
-- or a restored copy, and `where id = 11` would reprice whatever happened to
-- land there instead.
update public.builds
   set price_cents = 5000
 where version = '1.4.46';

comment on column public.builds.price_cents is
  'What this build costs, in cents. The only authority on price: create-checkout '
  'reads it into Stripe''s unit_amount and the browser cannot influence it. '
  'Zero means not for sale, which is what keeps the withdrawn builds unsellable.';
