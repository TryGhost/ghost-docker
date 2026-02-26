-- Configure Ghost to route Mailgun API calls to the local SES adapter
-- Idempotent: safe to run multiple times

INSERT INTO settings (`key`, `value`, `type`, `created_at`, `updated_at`)
VALUES ('mailgun_base_url', 'http://ses-adapter:3001/v3', 'core', NOW(), NOW())
ON DUPLICATE KEY UPDATE
    value = 'http://ses-adapter:3001/v3',
    updated_at = NOW();