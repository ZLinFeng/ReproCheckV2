import html
from html.parser import HTMLParser
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


class Text(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'noscript', 'svg'):
            self.hidden += 1

    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'noscript', 'svg') and self.hidden:
            self.hidden -= 1

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def get(url, limit):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('unsupported URL')
    request = urllib.request.Request(url, headers={'User-Agent': 'ReproCheck/1.0 (research)', 'Accept': 'text/html,text/plain,application/json,application/rss+xml,application/xml,text/xml'})
    with urllib.request.urlopen(request, timeout=8) as response:
        if response.status != 200:
            raise ValueError('HTTP ' + str(response.status))
        kind = response.headers.get_content_type()
        if kind not in ('text/html', 'text/plain', 'application/json', 'application/rss+xml', 'application/xml', 'text/xml'):
            raise ValueError('unsupported content type')
        data = response.read(limit + 1)
        return response.geturl(), kind, data[:limit].decode('utf-8', 'replace'), len(data) > limit


def main():
    queries = json.loads(sys.argv[1])
    searches = []
    candidates = []
    errors = []
    for query in queries:
        try:
            words = re.findall(r'[\w.-]+', query['query'], re.UNICODE)
            ignored = {'github', 'code', 'coding', 'open', 'source', 'project', 'task', 'tasks', 'dataset', 'data', 'the', 'a', 'and'}
            terms = [word for word in words if word.lower() not in ignored and len(word) > 1][:2]
            if not terms:
                raise ValueError('no usable repository search terms')
            url = 'https://api.github.com/search/repositories?' + urllib.parse.urlencode({'q': ' '.join(terms), 'per_page': 3})
            _, _, body, truncated = get(url, 128000)
            if truncated:
                raise ValueError('truncated repository search')
            found = []
            for item in json.loads(body).get('items', [])[:3]:
                name = item.get('full_name', '')
                branch = item.get('default_branch', '')
                if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', name) or not branch:
                    continue
                raw = 'https://raw.githubusercontent.com/' + name + '/' + urllib.parse.quote(branch, safe='') + '/README.md'
                title = (item.get('description') or name)[:300]
                found.append({'url': item.get('html_url', ''), 'title': title})
                if len(found) == 1 and raw not in [candidate['url'] for candidate in candidates]:
                    candidates.append({'url': raw, 'title': title, 'claimId': query['claimId'], 'rank': 0})
            searches.append({**query, 'provider': 'github', 'results': found})
        except Exception as error:
            errors.append({'query': query['query'], 'error': 'GitHub: ' + str(error)[:280]})
        try:
            url = 'https://www.bing.com/search?' + urllib.parse.urlencode({'format': 'rss', 'q': query['query']})
            _, _, body, truncated = get(url, 128000)
            if truncated or '<!DOCTYPE' in body.upper() or '<!ENTITY' in body.upper():
                raise ValueError('invalid or truncated search results')
            root = ET.fromstring(body)
            found = []
            selected = False
            keywords = [word.lower() for word in re.findall(r'[\w.-]+', query['query']) if len(word) >= 4
                        and word.lower() not in {'github', 'benchmark', 'dataset', 'tasks', 'source', 'project'}]
            for item in root.findall('./channel/item')[:4]:
                link = (item.findtext('link') or '').strip()
                title = html.unescape(item.findtext('title') or '').strip()[:300]
                if urllib.parse.urlsplit(link).scheme in ('http', 'https'):
                    found.append({'url': link, 'title': title})
                    if not selected and any(word in title.lower() for word in keywords) and link not in [candidate['url'] for candidate in candidates]:
                        candidates.append({'url': link, 'title': title, 'claimId': query['claimId'], 'rank': 1})
                        selected = True
            searches.append({**query, 'provider': 'bing', 'results': found})
        except Exception as error:
            errors.append({'query': query['query'], 'error': str(error)[:300]})
    sources = []
    for candidate in sorted(candidates, key=lambda item: item['rank'])[:4]:
        try:
            url, kind, body, truncated = get(candidate['url'], 80000)
            if kind == 'text/html':
                parser = Text()
                parser.feed(body)
                body = ' '.join(parser.parts)
            body = ' '.join(body.split())
            truncated = truncated or len(body) > 12000
            body = body[:12000]
            if body:
                sources.append({**{key: value for key, value in candidate.items() if key != 'rank'}, 'url': url, 'content': body, 'truncated': truncated})
        except Exception as error:
            errors.append({'url': candidate['url'], 'error': str(error)[:300]})
    print(json.dumps({'value': len(sources), 'searches': searches, 'sources': sources, 'errors': errors}, ensure_ascii=False))


main()
