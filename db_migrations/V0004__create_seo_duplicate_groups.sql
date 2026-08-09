CREATE TABLE IF NOT EXISTS seo_duplicate_groups (
    id SERIAL PRIMARY KEY,
    content_hash VARCHAR(64) NOT NULL,
    wp_post_id INTEGER NOT NULL,
    product_title TEXT,
    content_length INTEGER,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seo_duplicate_groups_hash ON seo_duplicate_groups(content_hash);