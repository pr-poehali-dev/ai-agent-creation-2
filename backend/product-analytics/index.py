import json
import os
import base64
import urllib.request
import urllib.error
import urllib.parse

CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-User-Id, X-Auth-Token, X-Session-Id',
    'Access-Control-Max-Age': '86400'
}


def wp_auth_header():
    username = os.environ.get('WP_USERNAME')
    app_password = os.environ.get('WP_APP_PASSWORD')
    token = base64.b64encode(f'{username}:{app_password}'.encode('utf-8')).decode('utf-8')
    return f'Basic {token}'


def wp_request(method, path, timeout=15):
    site_url = (os.environ.get('WP_SITE_URL') or '').rstrip('/')
    url = f'{site_url}/wp-json/{path}'
    req = urllib.request.Request(
        url,
        method=method,
        headers={
            'Authorization': wp_auth_header(),
            'Content-Type': 'application/json',
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode('utf-8', errors='replace')
            return resp.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        err_body = e.read().decode('utf-8', errors='replace')
        try:
            return e.code, json.loads(err_body)
        except Exception:
            return e.code, {'error': err_body}


def handler(event: dict, context) -> dict:
    """Диагностическая функция: проверяет доступность WooCommerce REST API (wc/v3)
    по товару, найденному через WordPress REST API по slug. Возвращает сырой ответ
    для каждого проверенного эндпоинта, чтобы понять, какие данные (остатки,
    продажи, заказы) вообще доступны с текущими учётными данными."""
    method = event.get('httpMethod', 'GET')
    if method == 'OPTIONS':
        return {'statusCode': 200, 'headers': CORS_HEADERS, 'body': ''}

    params = event.get('queryStringParameters') or {}
    slug = params.get('slug')
    if not slug:
        return {
            'statusCode': 400,
            'headers': {**CORS_HEADERS, 'Content-Type': 'application/json'},
            'body': json.dumps({'error': 'Не передан параметр slug'}, ensure_ascii=False),
        }

    result = {}

    status, wp_products = wp_request('GET', f'wp/v2/product?slug={urllib.parse.quote(slug)}')
    result['wp_v2_product'] = {'status': status, 'data': wp_products}

    if status == 200 and isinstance(wp_products, list) and wp_products:
        post_id = wp_products[0].get('id')
        result['post_id'] = post_id

        status_wc, wc_product = wp_request('GET', f'wc/v3/products/{post_id}')
        result['wc_v3_product'] = {'status': status_wc, 'data': wc_product}

        status_orders, wc_orders = wp_request('GET', f'wc/v3/orders?product={post_id}&per_page=100&status=any')
        result['wc_v3_orders'] = {'status': status_orders, 'data': wc_orders}

    return {
        'statusCode': 200,
        'headers': {**CORS_HEADERS, 'Content-Type': 'application/json'},
        'body': json.dumps(result, ensure_ascii=False),
    }
