-- Staff onboarding: when a non-owner member finished their first-sign-in flow (null = not yet).
ALTER TABLE app_memberships ADD COLUMN IF NOT EXISTS onboarded_at BIGINT;
-- Existing members have been using the workspace already; don't show them the flow retroactively.
UPDATE app_memberships SET onboarded_at = (EXTRACT(EPOCH FROM now()) * 1000)::bigint WHERE role <> 'OWNER' AND onboarded_at IS NULL;
