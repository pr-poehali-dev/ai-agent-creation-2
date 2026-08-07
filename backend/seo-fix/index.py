import json
import os
import base64
import urllib.request
import urllib.error

import psycopg2  # noqa: F401 автоисправление SEO через WP REST API

CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-User-Id, X-Auth-Token, X-Session-Id',
    'Access-Control-Max-Age': '86400'
}


def get_db_connection():
    dsn = os.environ.get('DATABASE_URL')
    if not dsn:
        return None
    return psycopg2.connect(dsn)


def table_name(name):
    schema = os.environ.get('MAIN_DB_SCHEMA')
    return f'"{schema}"."{name}"' if schema else name


def wp_auth_header():
    username = os.environ.get('WP_USERNAME')
    app_password = os.environ.get('WP_APP_PASSWORD')
    token = base64.b64encode(f'{username}:{app_password}'.encode('utf-8')).decode('utf-8')
    return f'Basic {token}'


def wp_request(method, path, payload=None, timeout=10):
    site_url = (os.environ.get('WP_SITE_URL') or '').rstrip('/')
    url = f'{site_url}/wp-json/{path}'
    data = json.dumps(payload).encode('utf-8') if payload is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            'Authorization': wp_auth_header(),
            'Content-Type': 'application/json',
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode('utf-8', errors='replace')
        return resp.status, json.loads(body) if body else {}


def apply_title_fix(post_id, post_type, new_title):
    status, resp = wp_request('POST', f'wp/v2/{post_type}/{post_id}', {'title': new_title})
    return status in (200, 201), resp


def apply_seo_title_fix(post_id, post_type, new_seo_title):
    # SEO-заголовок Rank Math (отдельно от заголовка записи)
    status, resp = wp_request(
        'POST', f'wp/v2/{post_type}/{post_id}',
        {'meta': {'rank_math_title': new_seo_title}},
    )
    return status in (200, 201), resp


def apply_description_fix(post_id, post_type, new_description):
    # Rank Math хранит meta description в поле rank_math_description
    status, resp = wp_request(
        'POST', f'wp/v2/{post_type}/{post_id}',
        {'meta': {'rank_math_description': new_description}},
    )
    return status in (200, 201), resp


def apply_og_fix(post_id, post_type, og_title, og_description):
    status, resp = wp_request(
        'POST', f'wp/v2/{post_type}/{post_id}',
        {'meta': {
            'rank_math_facebook_title': og_title,
            'rank_math_facebook_description': og_description,
        }},
    )
    return status in (200, 201), resp


def generate_description(context_title, context_h1):
    api_key = os.environ.get('OPENAI_API_KEY')
    base = context_h1 or context_title or 'Страница сайта'
    if not api_key:
        return f'{base}. Узнайте больше на нашем сайте.'[:155]
    prompt = (
        f"Напиши SEO meta description на русском для страницы с заголовком «{base}». "
        "Длина строго 120-155 символов, без кавычек, без эмодзи, цепляющий текст с призывом к действию."
    )
    try:
        req = urllib.request.Request(
            'https://api.openai.com/v1/chat/completions',
            data=json.dumps({
                'model': 'gpt-4o-mini',
                'messages': [{'role': 'user', 'content': prompt}],
                'temperature': 0.6,
                'max_tokens': 150,
            }).encode('utf-8'),
            headers={
                'Authorization': f'Bearer {api_key}',
                'Content-Type': 'application/json',
            },
            method='POST',
        )
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            text = data['choices'][0]['message']['content'].strip().strip('"')
            return text[:160]
    except Exception:
        return f'{base}. Узнайте больше на нашем сайте.'[:155]


def save_fix(audit_id, check_id, fix_type, old_value, new_value, status, message):
    conn = get_db_connection()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                INSERT INTO {table_name('seo_fixes')} (audit_id, check_id, fix_type, old_value, new_value, status, message)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                (audit_id, check_id, fix_type, old_value, new_value, status, message),
            )
        conn.commit()
    finally:
        conn.close()


def get_audit(audit_id):
    conn = get_db_connection()
    if not conn:
        return None
    try:
        with conn.cursor() as cur:
            cur.execute(
                f'SELECT url, wp_post_id, wp_post_type, raw_data, wp_available FROM {table_name("seo_audits")} WHERE id = %s',
                (audit_id,),
            )
            row = cur.fetchone()
            if not row:
                return None
            return {
                'url': row[0],
                'wp_post_id': row[1],
                'wp_post_type': row[2],
                'raw_data': row[3],
                'wp_available': row[4],
            }
    finally:
        conn.close()


def handler(event: dict, context) -> dict:
    """Применяет автоматическое исправление найденной технической SEO-проблемы
    на сайте WordPress через REST API (title, meta description и Open Graph теги
    в Rank Math), сохраняет результат исправления в базу данных."""

    method = event.get('httpMethod', 'GET')

    if method == 'OPTIONS':
        return {'statusCode': 200, 'headers': CORS_HEADERS, 'body': ''}

    if method != 'POST':
        return {
            'statusCode': 405,
            'headers': {**CORS_HEADERS, 'Content-Type': 'application/json'},
            'body': json.dumps({'error': 'Метод не поддерживается'}),
        }

    try:
        body = json.loads(event.get('body') or '{}')
    except json.JSONDecodeError:
        body = {}

    audit_id = body.get('audit_id')
    check_id = (body.get('check_id') or '').strip()
    custom_value = (body.get('value') or '').strip() or None

    if not audit_id or not check_id:
        return {
            'statusCode': 400,
            'headers': {**CORS_HEADERS, 'Content-Type': 'application/json'},
            'body': json.dumps({'error': 'Не хватает audit_id или check_id'}),
        }

    if not os.environ.get('WP_SITE_URL') or not os.environ.get('WP_USERNAME') or not os.environ.get('WP_APP_PASSWORD'):
        return {
            'statusCode': 200,
            'headers': {**CORS_HEADERS, 'Content-Type': 'application/json'},
            'body': json.dumps({'error': 'Доступ к WordPress не настроен'}),
        }

    audit = get_audit(audit_id)
    if not audit:
        return {
            'statusCode': 404,
            'headers': {**CORS_HEADERS, 'Content-Type': 'application/json'},
            'body': json.dumps({'error': 'Проверка не найдена'}),
        }

    if not audit['wp_post_id'] or not audit['wp_post_type']:
        return {
            'statusCode': 200,
            'headers': {**CORS_HEADERS, 'Content-Type': 'application/json'},
            'body': json.dumps({'error': 'Не удалось определить страницу WordPress для этого URL'}),
        }

    post_id = audit['wp_post_id']
    post_type = audit['wp_post_type']
    raw = audit['raw_data'] or {}

    try:
        if check_id == 'title':
            new_title = custom_value or (raw.get('h1') or 'Страница сайта')
            ok, resp = apply_title_fix(post_id, post_type, new_title)
            old_value = raw.get('current_title', '')
            save_fix(audit_id, check_id, 'title', old_value, new_title, 'success' if ok else 'error',
                      'Title обновлён' if ok else f'Ошибка WordPress: {resp}')
            message = 'Title успешно обновлён' if ok else 'Не удалось обновить title'

        elif check_id == 'description':
            new_description = custom_value or generate_description(raw.get('current_title'), raw.get('h1'))
            ok, resp = apply_description_fix(post_id, post_type, new_description)
            old_value = raw.get('current_description', '')
            save_fix(audit_id, check_id, 'description', old_value, new_description, 'success' if ok else 'error',
                      'Meta description обновлено' if ok else f'Ошибка WordPress: {resp}')
            message = 'Meta description успешно обновлено' if ok else 'Не удалось обновить description'

        elif check_id == 'seo_title':
            new_seo_title = custom_value or (raw.get('current_title') or raw.get('h1') or 'Страница сайта')
            ok, resp = apply_seo_title_fix(post_id, post_type, new_seo_title)
            save_fix(audit_id, check_id, 'seo_title', '', new_seo_title, 'success' if ok else 'error',
                      'SEO-заголовок обновлён' if ok else f'Ошибка WordPress: {resp}')
            message = 'SEO-заголовок успешно обновлён' if ok else 'Не удалось обновить SEO-заголовок'

        elif check_id == 'og_tags':
            og_title = raw.get('current_title') or raw.get('h1') or ''
            og_description = custom_value or generate_description(raw.get('current_title'), raw.get('h1'))
            ok, resp = apply_og_fix(post_id, post_type, og_title, og_description)
            save_fix(audit_id, check_id, 'og_tags', '', f'{og_title} / {og_description}', 'success' if ok else 'error',
                      'Open Graph теги обновлены' if ok else f'Ошибка WordPress: {resp}')
            message = 'Open Graph теги успешно обновлены' if ok else 'Не удалось обновить Open Graph'

        else:
            return {
                'statusCode': 200,
                'headers': {**CORS_HEADERS, 'Content-Type': 'application/json'},
                'body': json.dumps({'error': f'Автоисправление для «{check_id}» пока не поддерживается'}),
            }

        return {
            'statusCode': 200,
            'headers': {**CORS_HEADERS, 'Content-Type': 'application/json'},
            'body': json.dumps({'success': ok, 'message': message}, ensure_ascii=False),
        }

    except urllib.error.HTTPError as e:
        err_body = e.read().decode('utf-8', errors='replace')
        save_fix(audit_id, check_id, check_id, '', '', 'error', f'HTTP {e.code}: {err_body[:300]}')
        return {
            'statusCode': 200,
            'headers': {**CORS_HEADERS, 'Content-Type': 'application/json'},
            'body': json.dumps({'success': False, 'message': f'Ошибка WordPress API: {e.code}'}, ensure_ascii=False),
        }
    except Exception as e:
        save_fix(audit_id, check_id, check_id, '', '', 'error', str(e)[:300])
        return {
            'statusCode': 200,
            'headers': {**CORS_HEADERS, 'Content-Type': 'application/json'},
            'body': json.dumps({'success': False, 'message': 'Не удалось применить исправление'}, ensure_ascii=False),
        }