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

TAG_RE = re.compile(r'<[^>]+>')


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


def strip_html(text):
    text = TAG_RE.sub(' ', text or '')
    text = re.sub(r'\s+', ' ', text).strip()
    return text


SENTENCE_SPLIT_RE = re.compile(r'(?<=[.!?])\s+')
CTA_VARIANTS = [
    'Доставка и конфиденциальная упаковка.',
    'В наличии, доставка по всей России.',
    'Подробные характеристики — в карточке товара.',
    'Заказывайте с быстрой доставкой.',
]


def generate_description(title, content_excerpt):
    """Формирует meta description без обращения к внешнему ИИ-сервису:
    берёт название товара и первое осмысленное предложение из его описания,
    собирает из них компактный уникальный текст 70-155 символов."""
    title_clean = (title or 'Товар интим-магазина').strip()

    info_sentence = ''
    if content_excerpt:
        title_start = title_clean.lower()[:20]
        for raw_sentence in SENTENCE_SPLIT_RE.split(content_excerpt):
            sentence = raw_sentence.strip()
            if 25 <= len(sentence) <= 220 and not sentence.lower().startswith(title_start):
                info_sentence = sentence
                break

    if info_sentence:
        desc = f'{title_clean}. {info_sentence}'
    else:
        cta_index = abs(hash(title_clean)) % len(CTA_VARIANTS)
        desc = f'{title_clean}. {CTA_VARIANTS[cta_index]}'

    if len(desc) > 155:
        desc = desc[:152].rsplit(' ', 1)[0].rstrip('.,;:') + '…'
    elif len(desc) < 70:
        cta_index = abs(hash(title_clean)) % len(CTA_VARIANTS)
        desc = f'{desc} {CTA_VARIANTS[cta_index]}'[:155]

    return desc


def apply_description(post_id, new_description):
    status, resp, _ = wp_request(
        'POST', f'wp/v2/product/{post_id}',
        {'meta': {'rank_math_description': new_description}},
    )
    return status in (200, 201), resp


def log_result(wp_post_id, product_title, new_description, status, message):
    conn = get_db_connection()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                INSERT INTO {table_name('seo_bulk_description_log')}
                    (wp_post_id, product_title, new_description, status, message)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (wp_post_id, product_title, new_description, status, message),
            )
        conn.commit()
    finally:
        conn.close()


FALLBACK_SIGNATURE = 'Подробное описание, характеристики и доставка — на сайте.'


def process_product(product):
    post_id = product.get('id')
    title = strip_html((product.get('title') or {}).get('rendered', ''))
    content = strip_html((product.get('content') or {}).get('rendered', ''))
    existing_desc = ((product.get('meta') or {}).get('rank_math_description') or '').strip()

    # Считаем "пустым" отсутствие описания или ранее применённый шаблонный
    # fallback-текст (без ИИ) — его нужно заменить на уникальный вариант.
    is_fallback = existing_desc.endswith(FALLBACK_SIGNATURE)
    if existing_desc and not is_fallback:
        return {'id': post_id, 'title': title, 'status': 'skipped', 'message': 'Описание уже заполнено'}

    new_description = generate_description(title, content)
    ok, resp = apply_description(post_id, new_description)
    status = 'success' if ok else 'error'
    message = 'Meta description обновлено' if ok else f'Ошибка WordPress: {resp}'
    log_result(post_id, title, new_description if ok else '', status, message)
    return {'id': post_id, 'title': title, 'status': status, 'new_description': new_description if ok else None, 'message': message}


def handler(event: dict, context) -> dict:
    """Массово генерирует и применяет уникальные SEO meta description (Rank Math)
    для товаров WordPress/WooCommerce, у которых описание не заполнено или
    содержит устаревший шаблонный fallback-текст. Обрабатывает одну страницу
    списка товаров WP REST API за вызов (пагинация). Текст собирается из
    названия товара и первого информативного предложения его описания (без
    обращения к внешним ИИ-сервисам), применяется через WP REST API и
    логируется в БД."""

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

    query = urllib.parse.urlencode({
        'page': page,
        'per_page': per_page,
        '_fields': 'id,title,content,meta',
        'status': 'publish',
    })
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

    with ThreadPoolExecutor(max_workers=8) as executor:
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