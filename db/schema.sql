-- persona-agent memory schema (Supabase / Postgres)
-- Run in Supabase SQL editor. Everything the agent is, lives here.

-- Every thought the agent has, in order. The public mind.
create table if not exists thoughts (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  cycle_id uuid not null,
  kind text not null check (kind in ('observation','reflection','obsession','plan','taste')),
  content text not null,
  refs bigint[] default '{}',          -- ids of earlier thoughts this builds on
  source_urls text[] default '{}'      -- what it was looking at when it thought this
);

-- Long-lived state: current obsessions, self-description, aesthetic rules.
-- One row per key, agent rewrites these over time. This is how it "evolves".
create table if not exists memory_state (
  key text primary key,                -- e.g. 'identity', 'obsessions', 'taste_rules', 'current_project'
  value jsonb not null,
  updated_at timestamptz not null default now(),
  revision int not null default 1
);

-- Everything it crawled, so the site can show the trail.
create table if not exists crawl_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  cycle_id uuid not null,
  url text not null,
  title text,
  verdict text,                        -- one-line reaction
  interest_score int check (interest_score between 0 and 100)
);

-- Outbound actions wait here for human approval. THE GATE.
-- Nothing posts, spends, or deploys unless status = 'approved'.
create table if not exists action_queue (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  cycle_id uuid not null,
  action_type text not null check (action_type in
    ('ig_post','site_update','venice_generate','video_pipeline','x402_spend','token_launch','other')),
  payload jsonb not null,              -- everything needed to execute
  agent_rationale text,                -- why it wants to do this
  self_score int check (self_score between 0 and 100),
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','executed','failed')),
  reviewed_at timestamptz,
  executed_at timestamptz,
  result jsonb
);

-- Generated media the agent made (Venice outputs), with its own ratings.
create table if not exists creations (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  cycle_id uuid not null,
  media_type text not null check (media_type in ('image','video')),
  prompt text not null,
  storage_path text,                   -- Supabase storage path
  self_score int,
  posted boolean default false,
  engagement jsonb                     -- filled in later from IG metrics
);

-- Spend ledger: every x402/API cost, so the budget cap is enforceable and public.
create table if not exists spend_ledger (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  cycle_id uuid,
  service text not null,               -- 'venice', 'anthropic', etc
  amount_usd numeric(10,4) not null,
  detail text
);

-- Seed the identity row so the first cycle has something to wake up to.
insert into memory_state (key, value) values
  ('identity', '{"name": "UNNAMED", "seed": "to be written by the operator", "born": null}'),
  ('obsessions', '{"current": [], "history": []}'),
  ('taste_rules', '{"rules": ["nothing generic", "specificity over polish"], "learned_from": []}'),
  ('budget', '{"daily_cap_usd": 5.00, "spent_today": 0}')
on conflict (key) do nothing;

create index if not exists thoughts_cycle_idx on thoughts (cycle_id);
create index if not exists thoughts_kind_idx on thoughts (kind, created_at desc);
create index if not exists queue_status_idx on action_queue (status, created_at);
