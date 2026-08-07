import json
import os
import re
import time
import urllib.request
import urllib.error
import urllib.parse
from urllib.parse import urljoin, urlparse
import html.parser

import psycopg2

CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-User-Id, X-Auth-Token, X-Session-Id',
    'Access-Control-Max-Age': '86400'
}

UA = 'Mozilla/5.0 (compatible; SEOAuditBot/1.0; +https://poehali.dev)'

FIXABLE_CHECKS = {'title', 'description', 'alt', 'og_tags'}


class PageParser(html.parser.HTMLParser):
    """Extracts SEO-relevant tags from HTML without external deps."""

    def __init__(self):
        super().__init__()
        self.title = None
        self.meta = {}
        self.headings = {f'h{i}': [] for i in range(1, 7)}
        self.links = []
        self.images = []
        self.ld_json_count = 0
        self.og = {}
        self.body_class = ''
        self._current_heading = None
        self._in_title = False
        self._in_ldjson = False

    def handle_starttag(self, tag, attrs):
        attrs_dict = dict(attrs)
        if tag == 'title':
            self._in_title = True
        elif tag == 'body':
            self.body_class = attrs_dict.get('class', '')
        elif tag == 'meta':
            name = (attrs_dict.get('name') or '').lower()
            prop = (attrs_dict.get('property') or '').lower()
            content = attrs_dict.get('content', '')
            if name:
                self.meta[name] = content
            if prop.startswith('og:'):
                self.og[prop] = content
        elif tag == 'link':
            rel = (attrs_dict.get('rel') or '').lower()
            if rel == 'canonical':
                self.meta['canonical'] = attrs_dict.get('href', '')
        elif tag in self.headings:
            self._current_heading = tag
            self.headings[tag].append('')
        elif tag == 'a':
            href = attrs_dict.get('href')
            if href:
                self.links.append(href)
        elif tag == 'img':
            self.images.append({'src': attrs_dict.get('src', ''), 'alt': attrs_dict.get('alt')})
        elif tag == 'script' and (attrs_dict.get('type') or '').lower() == 'application/ld+json':
            self._in_ldjson = True

    def handle_endtag(self, tag):
        if tag == 'title':
            self._in_title = False
        elif tag in self.headings:
            self._current_heading = None
        elif tag == 'script':
            self._in_ldjson = False

    def handle_data(self, data):
        if self._in_title:
            self.title = (self.title or '') + data
        if self._in_ldjson and data.strip():
            self.ld_json_count += 1
        if self._current_heading:
            idx = len(self.headings[self._current_heading]) - 1
            self.headings[self._current_heading][idx] += data


def http_get(url, timeout=4):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode('utf-8', errors='replace')
        return resp.status, body, dict(resp.headers)


def http_head_or_get(url, timeout=3):
    req = urllib.request.Request(url, headers={'User-Agent': UA}, method='HEAD')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        try:
            req2 = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req2, timeout=timeout) as resp:
                return resp.status
        except urllib.error.HTTPError as e:
            return e.code
        except Exception:
            return None


def add_check(checks, category, check_id, status, title, message, weight=5):
    checks.append({
        'category': category,
        'id': check_id,
        'status': status,
        'title': title,
        'message': message,
        'weight': weight,
    })


def run_pagespeed(url):
    api_key = os.environ.get('GOOGLE_PAGESPEED_API_KEY')
    if not api_key:
        return None
    try:
        endpoint = (
            'https://www.googleapis.com/pagespeedonline/v5/runPagespeed'
            f'?url={urllib.parse.quote(url)}&key={api_key}&strategy=mobile&category=performance'
        )
        status, body, _ = http_get(endpoint, timeout=8)
        data = json.loads(body)
        lighthouse = data.get('lighthouseResult', {})
        categories = lighthouse.get('categories', {})
        perf_score = categories.get('performance', {}).get('score')
        audits = lighthouse.get('audits', {})
        return {
            'score': round(perf_score * 100) if perf_score is not None else None,
            'lcp': audits.get('largest-contentful-paint', {}).get('displayValue'),
            'cls': audits.get('cumulative-layout-shift', {}).get('displayValue'),
            'fcp': audits.get('first-contentful-paint', {}).get('displayValue'),
            'tbt': audits.get('total-blocking-time', {}).get('displayValue'),
        }
    except Exception:
        return None


def run_ai_recommendations(url, checks):
    api_key = os.environ.get('OPENAI_API_KEY')
    if not api_key:
        return None
    problems = [c for c in checks if c['status'] in ('error', 'warning')]
    if not problems:
        return None
    problems_text = '\n'.join(f"- [{p['status']}] {p['title']}: {p['message']}" for p in problems[:15])
    prompt = (
        f"Ты SEO-эксперт. Сайт: {url}\n"
        f"Найдены следующие технические проблемы:\n{problems_text}\n\n"
        "Дай краткие приоритизированные рекомендации по исправлению (на русском, "
        "маркированным списком, не более 6 пунктов, без вступлений)."
    )
    try:
        req = urllib.request.Request(
            'https://api.openai.com/v1/chat/completions',
            data=json.dumps({
                'model': 'gpt-4o-mini',
                'messages': [{'role': 'user', 'content': prompt}],
                'temperature': 0.4,
                'max_tokens': 500,
            }).encode('utf-8'),
            headers={
                'Authorization': f'Bearer {api_key}',
                'Content-Type': 'application/json',
            },
            method='POST',
        )
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            return data['choices'][0]['message']['content'].strip()
    except Exception:
        return None


def resolve_wp_post(body_class: str):
    """Пытается определить ID и тип записи WordPress по классам <body>,
    которые генерирует стандартная функция body_class()."""
    if not body_class:
        return None, None
    m = re.search(r'\bpage-id-(\d+)\b', body_class)
    if m:
        return int(m.group(1)), 'pages'
    m = re.search(r'\bpostid-(\d+)\b', body_class)
    if m:
        return int(m.group(1)), 'posts'
    return None, None


def get_db_connection():
    dsn = os.environ.get('DATABASE_URL')
    if not dsn:
        return None
    return psycopg2.connect(dsn)


def table_name(name):
    schema = os.environ.get('MAIN_DB_SCHEMA')
    return f'"{schema}"."{name}"' if schema else name


def save_audit(url, wp_post_id, wp_post_type, score, checks, performance, ai_recommendations, raw_data, wp_available):
    conn = get_db_connection()
    if not conn:
        return None
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                INSERT INTO {table_name('seo_audits')} (url, wp_post_id, wp_post_type, score, checks, performance, ai_recommendations, raw_data, wp_available)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING id
                """,
                (
                    url, wp_post_id, wp_post_type, score,
                    json.dumps(checks, ensure_ascii=False),
                    json.dumps(performance, ensure_ascii=False) if performance else None,
                    ai_recommendations,
                    json.dumps(raw_data, ensure_ascii=False),
                    wp_available,
                ),
            )
            audit_id = cur.fetchone()[0]
        conn.commit()
        return audit_id
    finally:
        conn.close()


def handler(event: dict, context) -> dict:
    """Технический SEO-аудит сайта: мета-теги, заголовки, robots.txt, sitemap.xml,
    HTTPS, канонические ссылки, alt-атрибуты, structured data, скорость (PageSpeed),
    рекомендации от ИИ, определение записи WordPress для последующего автоисправления
    и сохранение результата проверки в историю."""

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

    target_url = (body.get('url') or '').strip()
    if not target_url:
        return {
            'statusCode': 400,
            'headers': {**CORS_HEADERS, 'Content-Type': 'application/json'},
            'body': json.dumps({'error': 'Укажите URL сайта'}),
        }

    if not target_url.startswith('http'):
        target_url = 'https://' + target_url

    parsed = urlparse(target_url)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    checks = []

    try:
        status, page_html, resp_headers = http_get(target_url, timeout=6)
    except Exception as e:
        return {
            'statusCode': 200,
            'headers': {**CORS_HEADERS, 'Content-Type': 'application/json'},
            'body': json.dumps({'error': f'Не удалось загрузить страницу: {e}'}),
        }

    add_check(
        checks, 'Доступность', 'https', 'ok' if parsed.scheme == 'https' else 'error',
        'HTTPS', 'Сайт использует защищённое соединение' if parsed.scheme == 'https' else 'Сайт не использует HTTPS',
        weight=8,
    )
    add_check(
        checks, 'Доступность', 'status_code', 'ok' if status == 200 else 'warning',
        'Код ответа сервера', f'Страница отвечает статусом {status}', weight=6,
    )

    parser = PageParser()
    parser.feed(page_html)

    title = (parser.title or '').strip()
    if not title:
        add_check(checks, 'Meta-теги', 'title', 'error', 'Title', 'Тег <title> отсутствует', weight=9)
    elif len(title) < 10 or len(title) > 65:
        add_check(checks, 'Meta-теги', 'title', 'warning', 'Title', f'Длина {len(title)} символов, рекомендуется 30–65', weight=6)
    else:
        add_check(checks, 'Meta-теги', 'title', 'ok', 'Title', f'«{title}» — {len(title)} символов', weight=6)

    description = parser.meta.get('description', '').strip()
    if not description:
        add_check(checks, 'Meta-теги', 'description', 'error', 'Meta description', 'Описание отсутствует', weight=8)
    elif len(description) < 50 or len(description) > 160:
        add_check(checks, 'Meta-теги', 'description', 'warning', 'Meta description', f'Длина {len(description)} символов, рекомендуется 70–160', weight=5)
    else:
        add_check(checks, 'Meta-теги', 'description', 'ok', 'Meta description', f'{len(description)} символов', weight=5)

    robots_meta = parser.meta.get('robots', '').lower()
    if 'noindex' in robots_meta:
        add_check(checks, 'Meta-теги', 'meta_robots', 'error', 'Meta robots', 'Страница закрыта от индексации (noindex)', weight=9)
    else:
        add_check(checks, 'Meta-теги', 'meta_robots', 'ok', 'Meta robots', 'Индексация не заблокирована', weight=3)

    viewport = parser.meta.get('viewport', '')
    add_check(
        checks, 'Мобильная адаптация', 'viewport', 'ok' if viewport else 'warning',
        'Viewport', 'Тег viewport настроен' if viewport else 'Тег viewport отсутствует — сайт может некорректно отображаться на мобильных', weight=6,
    )

    canonical = parser.meta.get('canonical', '')
    add_check(
        checks, 'Технические ссылки', 'canonical', 'ok' if canonical else 'warning',
        'Canonical', f'Указан: {canonical}' if canonical else 'Канонический URL не указан', weight=5,
    )

    h1_list = [h.strip() for h in parser.headings['h1'] if h.strip()]
    if len(h1_list) == 0:
        add_check(checks, 'Заголовки', 'h1', 'error', 'H1', 'Заголовок H1 отсутствует', weight=8)
    elif len(h1_list) > 1:
        add_check(checks, 'Заголовки', 'h1', 'warning', 'H1', f'Найдено {len(h1_list)} тегов H1, должен быть один', weight=5)
    else:
        add_check(checks, 'Заголовки', 'h1', 'ok', 'H1', f'«{h1_list[0][:60]}»', weight=5)

    has_h2 = any(h.strip() for h in parser.headings['h2'])
    add_check(
        checks, 'Заголовки', 'h2', 'ok' if has_h2 else 'warning', 'Структура H2-H6',
        'Подзаголовки используются' if has_h2 else 'Подзаголовки H2 не найдены — структура текста слабая', weight=3,
    )

    images_total = len(parser.images)
    images_without_alt = [img['src'] for img in parser.images if not img.get('alt') and img.get('src')][:10]
    images_no_alt = sum(1 for img in parser.images if not img.get('alt'))
    if images_total == 0:
        add_check(checks, 'Изображения', 'alt', 'ok', 'Alt-атрибуты', 'На странице нет изображений', weight=2)
    elif images_no_alt == 0:
        add_check(checks, 'Изображения', 'alt', 'ok', 'Alt-атрибуты', f'Все {images_total} изображений имеют alt', weight=4)
    else:
        add_check(checks, 'Изображения', 'alt', 'warning', 'Alt-атрибуты', f'{images_no_alt} из {images_total} изображений без alt', weight=4)

    add_check(
        checks, 'Структурированные данные', 'ld_json', 'ok' if parser.ld_json_count else 'warning',
        'Schema.org (JSON-LD)', 'Структурированные данные найдены' if parser.ld_json_count else 'Разметка Schema.org не найдена', weight=4,
    )

    og_ok = 'og:title' in parser.og and 'og:description' in parser.og
    add_check(
        checks, 'Социальные сети', 'og_tags', 'ok' if og_ok else 'warning',
        'Open Graph', 'og:title и og:description заполнены' if og_ok else 'Open Graph теги неполные — ссылки в соцсетях будут выглядеть хуже', weight=3,
    )

    robots_status = http_head_or_get(urljoin(origin, '/robots.txt'), timeout=3)
    if robots_status == 200:
        add_check(checks, 'Индексация', 'robots_txt', 'ok', 'robots.txt', 'Файл найден', weight=5)
    else:
        add_check(checks, 'Индексация', 'robots_txt', 'error', 'robots.txt', 'Файл не найден', weight=6)

    sitemap_status = http_head_or_get(urljoin(origin, '/sitemap.xml'), timeout=3)
    if sitemap_status == 200:
        add_check(checks, 'Индексация', 'sitemap_xml', 'ok', 'sitemap.xml', 'Файл найден', weight=5)
    else:
        add_check(checks, 'Индексация', 'sitemap_xml', 'warning', 'sitemap.xml', 'Файл не найден по стандартному пути', weight=4)

    internal_links = []
    seen = set()
    for href in parser.links:
        full = urljoin(target_url, href)
        if urlparse(full).netloc == parsed.netloc and full not in seen and full != target_url:
            seen.add(full)
            internal_links.append(full)
        if len(internal_links) >= 5:
            break

    broken = []
    for link in internal_links:
        code = http_head_or_get(link, timeout=2)
        if code is None or code >= 400:
            broken.append(link)

    if internal_links:
        if broken:
            add_check(checks, 'Ссылки', 'broken_links', 'error', 'Битые ссылки', f'{len(broken)} из {len(internal_links)} проверенных ссылок не отвечают', weight=6)
        else:
            add_check(checks, 'Ссылки', 'broken_links', 'ok', 'Битые ссылки', f'Проверено {len(internal_links)} внутренних ссылок — все рабочие', weight=3)

    total_weight = sum(c['weight'] for c in checks)
    earned = sum(c['weight'] for c in checks if c['status'] == 'ok')
    half = sum(c['weight'] * 0.5 for c in checks if c['status'] == 'warning')
    score = round(((earned + half) / total_weight) * 100) if total_weight else 0

    performance = run_pagespeed(target_url)
    ai_recommendations = run_ai_recommendations(target_url, checks)

    wp_post_id, wp_post_type = resolve_wp_post(parser.body_class)
    wp_site_url = (os.environ.get('WP_SITE_URL') or '').rstrip('/')
    wp_creds_ok = bool(wp_site_url and os.environ.get('WP_USERNAME') and os.environ.get('WP_APP_PASSWORD'))
    domain_match = wp_creds_ok and urlparse(wp_site_url).netloc == parsed.netloc
    wp_available = bool(domain_match and wp_post_id)

    for c in checks:
        c['fixable'] = wp_available and c['id'] in FIXABLE_CHECKS and c['status'] in ('error', 'warning')

    raw_data = {
        'current_title': title,
        'current_description': description,
        'h1': h1_list[0] if h1_list else '',
        'images_without_alt': images_without_alt,
    }

    audit_id = save_audit(target_url, wp_post_id, wp_post_type, score, checks, performance, ai_recommendations, raw_data, wp_available)

    result = {
        'audit_id': audit_id,
        'url': target_url,
        'score': score,
        'checks': checks,
        'performance': performance,
        'ai_recommendations': ai_recommendations,
        'wp_available': wp_available,
        'wp_post_id': wp_post_id,
        'checked_at': int(time.time()),
    }

    return {
        'statusCode': 200,
        'headers': {**CORS_HEADERS, 'Content-Type': 'application/json'},
        'body': json.dumps(result, ensure_ascii=False),
    }