CREATE TABLE IF NOT EXISTS seo_audits (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL,
    wp_post_id INTEGER,
    wp_post_type VARCHAR(20),
    score INTEGER NOT NULL,
    checks JSONB NOT NULL,
    performance JSONB,
    ai_recommendations TEXT,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seo_fixes (
    id SERIAL PRIMARY KEY,
    audit_id INTEGER NOT NULL,
    check_id VARCHAR(50) NOT NULL,
    fix_type VARCHAR(30) NOT NULL,
    old_value TEXT,
    new_value TEXT,
    status VARCHAR(20) NOT NULL,
    message TEXT,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seo_audits_url ON seo_audits(url);
CREATE INDEX IF NOT EXISTS idx_seo_fixes_audit_id ON seo_fixes(audit_id);