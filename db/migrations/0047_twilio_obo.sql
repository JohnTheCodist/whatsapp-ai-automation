-- Twilio On-Behalf-Of: what a pharmacy's own WhatsApp account needs.
--
-- WHAT WAS ALREADY HERE, AND IS NOT DUPLICATED
-- whatsapp_accounts was designed for Twilio before the Baileys detour, so it
-- already carries provider ('baileys' | 'twilio' | 'meta_cloud'), waba_id,
-- phone_number_id, provider_sid and credentials_ref. provider IS the
-- per-pharmacy channel switch — one pharmacy can be on Baileys while the next
-- is on Twilio, with no flag day and no big-bang migration. Adding a second
-- column meaning the same thing would guarantee they disagree eventually.
--
-- provider_sid is the Twilio Sender SID. credentials_ref is deliberately a
-- REFERENCE and not a credential: see the comment on it below.

-- The Meta Business Manager id, which is NOT the WABA id.
--
-- waba_id identifies the WhatsApp Business Account. meta_business_id
-- identifies the Business Manager that owns it, and the two are routinely
-- confused because both are long numeric strings that arrive together during
-- onboarding. Under OBO the business id is what says whose business this
-- account belongs to, so storing only the WABA leaves us unable to answer
-- that later — and unable to hand the pharmacy their own account if they
-- ever leave.
alter table whatsapp_accounts
  add column if not exists meta_business_id text;

comment on column whatsapp_accounts.meta_business_id is
  'Meta Business Manager id that owns this WABA. NOT waba_id — that is the WhatsApp Business '
  'Account itself. Set during On-Behalf-Of onboarding; null for baileys accounts, which have '
  'no Meta business behind them at all.';

comment on column whatsapp_accounts.credentials_ref is
  'A POINTER to where this account''s provider credentials live (a secret manager key, a '
  'Twilio subaccount SID) — never the credential itself, and never a password belonging to '
  'the pharmacy. A row that holds someone else''s login is a row that ends the company when '
  'the database leaks; a row that holds a lookup key is not.';

-- ---------------------------------------------------------------- templates
--
-- WHY TEMPLATES NEED A TABLE AND NOT JUST CONSTANTS IN CODE
-- The canonical wording lives in code (one set, shared by every pharmacy —
-- that is the point of a global template). What cannot live in code is what
-- happened to it: Meta reviews each pharmacy's copy separately, approval is
-- asynchronous and takes hours to days, and a template can be REJECTED, or
-- approved and later paused for poor quality.
--
-- "Push the templates the moment a client goes active" is the easy half.
-- The half that decides whether a customer gets told their order is ready is
-- knowing, at send time, whether THIS pharmacy's copy of THIS template is
-- approved right now. Without this table the send path has to ask Twilio on
-- every message, or guess — and guessing means a message that silently never
-- arrives.
create table if not exists whatsapp_templates (
  id                    uuid primary key default gen_random_uuid(),
  pharmacy_id           uuid not null references pharmacies(id) on delete cascade,

  -- Which of OUR canonical templates this is: 'order_ready',
  -- 'order_confirmed', and so on. The key is ours and stable; the provider's
  -- id for it is theirs and is not.
  template_key          text not null,
  language              text not null default 'en',

  provider              text not null default 'twilio'
                        check (provider in ('twilio', 'meta_cloud')),
  -- Whatever the provider calls this template on their side, once they have
  -- accepted it. Null until submission succeeds.
  provider_template_id  text,

  -- 'pending' is the state a template spends most of its early life in, and
  -- it is NOT approved. 'paused' and 'disabled' exist because Meta can revoke
  -- an approved template on quality grounds without anyone here doing
  -- anything — a state that is invisible until messages stop arriving.
  status                text not null default 'pending'
                        check (status in ('pending', 'approved', 'rejected', 'paused', 'disabled')),
  -- Meta's own words when it refuses. Kept verbatim: rewriting a rejection
  -- reason into our own phrasing loses the detail that says how to fix it.
  status_detail         text,

  submitted_at          timestamptz,
  reviewed_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- One row per pharmacy per template per language. Re-submitting updates
  -- this row rather than accumulating a history of attempts, because the
  -- question the send path asks is only ever "what is the state NOW".
  unique (pharmacy_id, template_key, language)
);

-- The send path's question, on every proactive message: is this pharmacy's
-- copy of this template usable right now? Indexed on exactly that.
create index if not exists whatsapp_templates_usable_idx
  on whatsapp_templates (pharmacy_id, template_key, language)
  where status = 'approved';

comment on table whatsapp_templates is
  'Per-pharmacy approval state of the global message templates. The wording lives in code; '
  'this records what each provider did with each pharmacy''s copy of it. A proactive message '
  'outside the 24-hour window may only be sent when the matching row here is ''approved''.';
