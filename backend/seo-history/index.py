import json
import os

import psycopg2
import psycopg2.extras

CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-User-Id, X-Auth-Token, X-Session-Id',
    'Access-Control-Max-Age': '86400'
}


def get_db_connection():
    dsn = os.environ.get('DATABASE_URL')
    return psycopg2.connect(dsn)


def table_name(name):
    schema = os.environ.get('MAIN_DB_SCHEMA')
    return f'"{schema}"."{name}"' if schema else name


def handler(event: dict, context) -> dict:
    """Возвращает историю всех проверок SEO-аудита и применённых
    автоматических исправлений с датами и результатами."""

    method = event.get('httpMethod', 'GET')

    if method == 'OPTIONS':
        return {'statusCode': 200, 'headers': CORS_HEADERS, 'body': ''}

    if method != 'GET':
        return {
            'statusCode': 405,
            'headers': {**CORS_HEADERS, 'Content-Type': 'application/json'},
            'body': json.dumps({'error': 'Метод не поддерживается'}),
        }

    params = event.get('queryStringParameters') or {}
    audit_id = params.get('audit_id')

    conn = get_db_connection()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            if audit_id:
                cur.execute(
                    f"""
                    SELECT id, check_id, fix_type, old_value, new_value, status, message, applied_at
                    FROM {table_name('seo_fixes')} WHERE audit_id = %s ORDER BY applied_at DESC
                    """,
                    (audit_id,),
                )
                fixes = cur.fetchall()
                return {
                    'statusCode': 200,
                    'headers': {**CORS_HEADERS, 'Content-Type': 'application/json'},
                    'body': json.dumps({'fixes': fixes}, ensure_ascii=False, default=str),
                }

            cur.execute(
                f"""
                SELECT id, url, score, wp_available, checked_at,
                    (SELECT COUNT(*) FROM {table_name('seo_fixes')} f WHERE f.audit_id = seo_audits.id AND f.status = 'success') AS fixes_count
                FROM {table_name('seo_audits')} AS seo_audits
                ORDER BY checked_at DESC
                LIMIT 50
                """
            )
            audits = cur.fetchall()
            return {
                'statusCode': 200,
                'headers': {**CORS_HEADERS, 'Content-Type': 'application/json'},
                'body': json.dumps({'audits': audits}, ensure_ascii=False, default=str),
            }
    finally:
        conn.close()