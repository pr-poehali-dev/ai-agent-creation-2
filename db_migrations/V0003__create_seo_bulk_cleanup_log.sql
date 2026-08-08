CREATE TABLE IF NOT EXISTS seo_bulk_cleanup_log (
    id SERIAL PRIMARY KEY,
    wp_post_id INTEGER NOT NULL,
    product_title TEXT,
    field VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL,
    message TEXT,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seo_bulk_cleanup_log_post_id ON seo_bulk_cleanup_log(wp_post_id);
CREATE INDEX IF NOT EXISTS idx_seo_bulk_cleanup_log_status ON seo_bulk_cleanup_log(status);