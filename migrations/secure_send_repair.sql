-- Secure Send repair migration (idempotent-ish)
-- Run with: sudo -u postgres psql -d pdfrealm -f migrations/secure_send_repair.sql

DO $$
BEGIN
  IF to_regclass('public.secure_shares') IS NULL THEN
    CREATE TABLE public.secure_shares (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      token_prefix text,
      object_ids jsonb NOT NULL,
      recipient_email text,
      note text,
      permissions text NOT NULL DEFAULT 'view_only',
      allow_download boolean NOT NULL DEFAULT false,
      allow_print boolean NOT NULL DEFAULT false,
      require_passcode boolean NOT NULL DEFAULT true,
      passcode_hash text,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz,
      revoked_at timestamptz,
      view_count integer NOT NULL DEFAULT 0,
      max_views integer,
      one_time boolean NOT NULL DEFAULT false
    );
  END IF;
END $$;

-- Columns (safe adds)
ALTER TABLE public.secure_shares ADD COLUMN IF NOT EXISTS owner_user_id uuid;
ALTER TABLE public.secure_shares ADD COLUMN IF NOT EXISTS token_hash text;
ALTER TABLE public.secure_shares ADD COLUMN IF NOT EXISTS token_prefix text;
ALTER TABLE public.secure_shares ADD COLUMN IF NOT EXISTS object_ids jsonb;
ALTER TABLE public.secure_shares ADD COLUMN IF NOT EXISTS recipient_email text;
ALTER TABLE public.secure_shares ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE public.secure_shares ADD COLUMN IF NOT EXISTS permissions text;
ALTER TABLE public.secure_shares ADD COLUMN IF NOT EXISTS allow_download boolean;
ALTER TABLE public.secure_shares ADD COLUMN IF NOT EXISTS allow_print boolean;
ALTER TABLE public.secure_shares ADD COLUMN IF NOT EXISTS require_passcode boolean;
ALTER TABLE public.secure_shares ADD COLUMN IF NOT EXISTS passcode_hash text;
ALTER TABLE public.secure_shares ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE public.secure_shares ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE public.secure_shares ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE public.secure_shares ADD COLUMN IF NOT EXISTS view_count integer;
ALTER TABLE public.secure_shares ADD COLUMN IF NOT EXISTS max_views integer;
ALTER TABLE public.secure_shares ADD COLUMN IF NOT EXISTS one_time boolean;

-- Defaults (best effort)
ALTER TABLE public.secure_shares ALTER COLUMN permissions SET DEFAULT 'view_only';
ALTER TABLE public.secure_shares ALTER COLUMN allow_download SET DEFAULT false;
ALTER TABLE public.secure_shares ALTER COLUMN allow_print SET DEFAULT false;
ALTER TABLE public.secure_shares ALTER COLUMN require_passcode SET DEFAULT true;
ALTER TABLE public.secure_shares ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.secure_shares ALTER COLUMN view_count SET DEFAULT 0;
ALTER TABLE public.secure_shares ALTER COLUMN one_time SET DEFAULT false;

-- Constraints (best effort)
DO $$
BEGIN
  BEGIN
    ALTER TABLE public.secure_shares
      ADD CONSTRAINT secure_shares_owner_user_id_fkey
      FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  BEGIN
    ALTER TABLE public.secure_shares
      ADD CONSTRAINT secure_shares_token_hash_key UNIQUE (token_hash);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_secure_shares_expires ON public.secure_shares (expires_at);
CREATE INDEX IF NOT EXISTS idx_secure_shares_owner_created ON public.secure_shares (owner_user_id, created_at DESC);

-- Audits table
DO $$
BEGIN
  IF to_regclass('public.secure_share_audits') IS NULL THEN
    CREATE TABLE public.secure_share_audits (
      id bigserial PRIMARY KEY,
      share_id uuid NOT NULL REFERENCES public.secure_shares(id) ON DELETE CASCADE,
      event text NOT NULL,
      ip text,
      user_agent text,
      detail jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_secure_share_audits_share_created ON public.secure_share_audits (share_id, created_at DESC);