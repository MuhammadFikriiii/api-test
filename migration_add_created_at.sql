-- =============================================
-- Migration: resolved_streams TTL support
-- Run in Supabase SQL Editor
-- =============================================

-- 1. Add created_at column (if not exists)
ALTER TABLE resolved_streams
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- 2. Add index for TTL queries
CREATE INDEX IF NOT EXISTS idx_resolved_streams_slug
    ON resolved_streams (episode_slug);

CREATE INDEX IF NOT EXISTS idx_resolved_streams_created_at
    ON resolved_streams (created_at);

-- 3. (Optional) Clean up existing stale entries
DELETE FROM resolved_streams
    WHERE hls_url LIKE '%ok.ru%'
      AND created_at < NOW() - INTERVAL '3 hours';

DELETE FROM resolved_streams
    WHERE hls_url NOT LIKE '%ok.ru%'
      AND created_at < NOW() - INTERVAL '3 days';
