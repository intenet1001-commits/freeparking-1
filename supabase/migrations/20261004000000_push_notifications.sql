create table if not exists public.fp_push_subscriptions (
  endpoint_hash text primary key check (length(endpoint_hash) = 64),
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.fp_push_events (
  event_key text primary key,
  title text not null,
  body text not null,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  sent_count integer not null default 0,
  failed_count integer not null default 0
);

alter table public.fp_push_subscriptions enable row level security;
alter table public.fp_push_events enable row level security;
revoke all on public.fp_push_subscriptions from anon, authenticated;
revoke all on public.fp_push_events from anon, authenticated;
grant select, insert, update, delete on public.fp_push_subscriptions to service_role;
grant select, insert, update, delete on public.fp_push_events to service_role;
