import json
import os
import re
import base64
import urllib.request
import urllib.error
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

import psycopg2

CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-User-Id, X-Auth-Token, X-Session-Id',
    'Access-Control-Max-Age': '86400'
}

# Промо-блок "Присоединяйтесь к нашему сообществу..." — ищем по паттерну,
# устойчивому к небольшим вариациям пробелов/переносов.
PROMO_BLOCK_RE = re.compile(
    r'\s*<p>\s*<em>\s*<a[^>]*href="https://t\.me/sexyfonlove"[^>]*>\s*Присоединяйтесь к нашему сообществу!\s*</a>\s*</em>\s*</p>'
    r'\s*<p>\s*<em>\s*Хотите быть в курсе.*?смелых игр\s*</em>\s*</p>',
    re.IGNORECASE | re.DOTALL,
)

# Более мягкий вариант на случай отличающейся разметки — по ключевым фразам
FALLBACK_RE = re.compile(
    r'<p>[^<]*Присоединяйтесь к нашему сообществу[^<]*</p>\s*<p>[^<]*Хотите быть в курсе.*?смелых игр[^<]*</p>',
    re.IGNORECASE | re.DOTALL,
)


def strip_promo_block(html_text):
    if not html_text:
        return html_text, False
    new_text = PROMO_BLOCK_RE.sub('', html_text)
    changed = new_text != html_text
    if not changed:
        new_text2 = FALLBACK_RE.sub('', html_text)
        changed = new_text2 != html_text
        new_text = new_text2
    return new_text.rstrip(), changed


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
        headers = dict(resp.headers)
        return resp.status, (json.loads(body) if body else {}), headers


def update_product_fields(post_id, fields):
    status, resp, _ = wp_request('POST', f'wp/v2/product/{post_id}', fields)
    return status in (200, 201), resp


def log_result(wp_post_id, product_title, field, status, message):
    conn = get_db_connection()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                INSERT INTO {table_name('seo_bulk_cleanup_log')}
                    (wp_post_id, product_title, field, status, message)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (wp_post_id, product_title, field, status, message),
            )
        conn.commit()
    finally:
        conn.close()


def process_product(product):
    post_id = product.get('id')
    title = re.sub(r'<[^>]+>', '', (product.get('title') or {}).get('rendered', ''))
    content = (product.get('content') or {}).get('rendered', '')
    excerpt = (product.get('excerpt') or {}).get('rendered', '')

    new_content, content_changed = strip_promo_block(content)
    new_excerpt, excerpt_changed = strip_promo_block(excerpt)

    if not content_changed and not excerpt_changed:
        return {'id': post_id, 'title': title, 'status': 'skipped', 'message': 'Промо-блок не найден'}

    fields = {}
    if content_changed:
        fields['content'] = new_content
    if excerpt_changed:
        fields['excerpt'] = new_excerpt

    ok, resp = update_product_fields(post_id, fields)
    status = 'success' if ok else 'error'
    message = (
        f"Убран блок из: {', '.join(fields.keys())}" if ok
        else f'Ошибка WordPress: {resp}'
    )
    log_result(post_id, title, ','.join(fields.keys()), status, message)
    return {'id': post_id, 'title': title, 'status': status, 'fields_changed': list(fields.keys()), 'message': message}


def handler(event: dict, context) -> dict:
    """Массово удаляет повторяющийся промо-блок ('Присоединяйтесь к нашему
    сообществу... Хотите быть в курсе самых горячих новинок...') из основного
    описания (content) и краткого описания (excerpt) товаров WordPress/WooCommerce.
    Обрабатывает одну страницу списка товаров WP REST API за вызов (пагинация),
    применяет изменения через WP REST API и логирует результат в БД."""

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

    page = int(body.get('page') or 1)
    per_page = min(int(body.get('per_page') or 15), 30)
    test_ids = body.get('ids')

    query_params = {
        '_fields': 'id,title,content,excerpt',
        'status': 'publish',
    }
    if test_ids:
        query_params['include'] = ','.join(str(i) for i in test_ids)
        query_params['per_page'] = len(test_ids)
    else:
        query_params['page'] = page
        query_params['per_page'] = per_page

    query = urllib.parse.urlencode(query_params)
    try:
        status, products, headers = wp_request('GET', f'wp/v2/product?{query}', timeout=15)
    except urllib.error.HTTPError as e:
        if e.code == 400:
            return {
                'statusCode': 200,
                'headers': {**CORS_HEADERS, 'Content-Type': 'application/json'},
                'body': json.dumps({'done': True, 'message': 'Достигнут конец списка товаров'}, ensure_ascii=False),
            }
        return {
            'statusCode': 200,
            'headers': {**CORS_HEADERS, 'Content-Type': 'application/json'},
            'body': json.dumps({'error': f'Ошибка WordPress: {e}'}, ensure_ascii=False),
        }

    total_pages = int(headers.get('X-WP-TotalPages', 1))
    total_items = int(headers.get('X-WP-Total', 0))

    if not isinstance(products, list) or not products:
        return {
            'statusCode': 200,
            'headers': {**CORS_HEADERS, 'Content-Type': 'application/json'},
            'body': json.dumps({'done': True, 'page': page, 'total_pages': total_pages}, ensure_ascii=False),
        }

    with ThreadPoolExecutor(max_workers=6) as executor:
        results = list(executor.map(process_product, products))

    processed = sum(1 for r in results if r['status'] == 'success')
    skipped = sum(1 for r in results if r['status'] == 'skipped')
    errors = sum(1 for r in results if r['status'] == 'error')

    return {
        'statusCode': 200,
        'headers': {**CORS_HEADERS, 'Content-Type': 'application/json'},
        'body': json.dumps({
            'page': page,
            'total_pages': total_pages,
            'total_items': total_items,
            'processed': processed,
            'skipped': skipped,
            'errors': errors,
            'done': page >= total_pages,
            'results': results,
        }, ensure_ascii=False),
    }