"""Check the UI over a loopback sample server with the host Chrome browser.

Usage: python3 app/tests/browser/browser-check.py BASE_URL EVIDENCE_DIRECTORY
Requires the host Python Playwright package. Installs nothing.
"""
import asyncio
import json
from pathlib import Path
import subprocess
import sys
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import urlopen

from playwright.async_api import async_playwright, expect


async def check(base, output):
    origin = urlparse(base)
    if origin.scheme != 'http' or origin.hostname not in ('localhost', '127.0.0.1') or origin.username:
        raise ValueError('Use a loopback sample server without credentials.')
    with urlopen(base + '/api/sources', timeout=5) as response:
        assert json.load(response)['mode'] == 'sample', 'Refuse a non-sample server.'
    fixtures = json.loads(subprocess.check_output(['node', str(Path(__file__).with_name('browser-fixtures.mjs'))]))
    output.mkdir(parents=True, exist_ok=True)
    results = []
    screenshots = []
    overview_proof = {}
    errors = []
    csp_errors = []
    requests = []
    external = []
    fail = set()
    plain_error = set()
    hold = {}
    entered = {}
    scenario = fixtures['scenarios']

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(channel='chrome', headless=True, args=['--no-sandbox', '--disable-gpu', '--hide-scrollbars'])
        context = await browser.new_context(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
        page = await context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.expose_binding('reportCsp', lambda source, directive: csp_errors.append(directive))
        await page.add_init_script("document.addEventListener('securitypolicyviolation', e => window.reportCsp(e.violatedDirective));")

        async def intercept(route):
            request = route.request
            url = urlparse(request.url)
            if (url.scheme, url.netloc) != (origin.scheme, origin.netloc):
                external.append(request.url)
                await route.abort()
                return
            if not url.path.startswith('/api/'):
                await route.continue_()
                return
            assert request.method == 'GET', request.method
            requests.append(url.path + ('?' + url.query if url.query else ''))
            query = parse_qs(url.query, keep_blank_values=True)
            part = url.path.rsplit('/', 1)[-1]
            refused = part in fail
            if part in entered:
                entered[part].set()
            if part in hold:
                await hold[part].wait()
            if part in plain_error:
                await route.fulfill(status=502, content_type='text/plain', body='Synthetic unavailable response.')
                return
            if refused:
                await route.fulfill(status=503, json={'mode': 'sample', 'error': {'message': scenario['errors'].get(part, 'Synthetic read failure.')}})
                return
            body = {'mode': 'sample'}
            if url.path == '/api/sources':
                body['sources'] = fixtures['sources']
            elif url.path == '/api/overview':
                body['sources'] = fixtures['overview']
            elif url.path == '/api/recent':
                body['items'] = fixtures['recent']
            elif url.path == '/api/search':
                selected = query.get('sources', [''])[0].split(',')
                body['results'] = [value for key, value in fixtures['searches'].items() if key in selected]
            else:
                source = url.path.split('/')[3]
                if part == 'item':
                    item = query['id'][0]
                    result = fixtures['entries'].get(source, {}).get(item)
                    if not result:
                        await route.fulfill(status=404, json={'mode': 'sample', 'error': {'message': 'No sample item has this id.'}})
                        return
                    body.update(result)
                elif part == 'browse':
                    path = query.get('path', [''])[0]
                    result = fixtures['browse'][source].get(path)
                    if result is None:
                        await route.fulfill(status=400, json={'mode': 'sample', 'error': {'message': 'No sample namespace has this path.'}})
                        return
                    if result.get('error'):
                        await route.fulfill(status=403 if result.get('state') == 'denied' else 502,
                                            json={'mode': 'sample', 'error': result['error']})
                        return
                    body.update(result)
                    offset = int(query.get('offset', ['0'])[0])
                    size = result.get('pageSize', 200)
                    body.update(items=result['items'][offset:offset + size], offset=offset, more=result.get('more', False) or offset + size < len(result['items']))
                elif part == 'search':
                    body.update(fixtures['searches'][source])
            await route.fulfill(json=body)

        await context.route('**/*', intercept)

        async def go(hash, selector):
            await page.goto(base + '/' + hash)
            await expect(page.locator(selector).first).to_be_visible()

        async def settled():
            await expect(page.locator('[aria-busy="true"]')).to_have_count(0)

        def passed(name):
            results.append(name)

        try:
            hold['overview'], entered['overview'] = asyncio.Event(), asyncio.Event()
            await page.goto(base + '/#/')
            await asyncio.wait_for(entered['overview'].wait(), 5)
            await expect(page.locator('#main .loading')).to_be_visible()
            hold.pop('overview').set()
            await expect(page.locator('.ledger')).to_be_visible()
            passed('Loading state stays visible until the ledger response arrives')
            names = await page.locator('.ledger tbody th .src-name').all_text_contents()
            assert names[:2] == ['OpenViking · Alice', 'OpenViking · Bob']
            # The page open reads no folder: the rail loads the folders of a source only on request.
            assert not any('/browse' in request for request in requests), requests
            # The rail groups by source type: each OpenViking source is one submenu item, no other source is.
            grouped = ['#/source/' + source['id'] for source in fixtures['sources'] if source['type'] == 'openviking']
            others = ['#/source/' + source['id'] for source in fixtures['sources'] if source['type'] != 'openviking']
            sub_links = page.locator('.rail-group.src-openviking .rail-sub a.nav-sub')
            assert await sub_links.evaluate_all('(nodes) => nodes.map(n => n.getAttribute("href"))') == grouped
            direct = await page.locator('.sources-nav li:not(.rail-group):not(.rail-group li) a.nav-link').evaluate_all('(nodes) => nodes.map(n => n.getAttribute("href"))')
            assert sorted(direct) == sorted(['#/'] + others), direct
            assert await page.locator('.sources-nav img').evaluate_all('(nodes) => nodes.every(n => n.complete && n.naturalWidth > 0)')
            group_toggle = page.locator('.rail-group.src-openviking .rail-group-toggle')
            await group_toggle.click()
            await expect(sub_links.first).to_be_hidden()
            await expect(group_toggle).to_have_attribute('aria-expanded', 'false')
            await expect(group_toggle).to_be_focused()
            await page.keyboard.press('Enter')
            await expect(sub_links.first).to_be_visible()
            passed('Rail groups OpenViking sources in one submenu; other sources stay outside; the group opens and closes by keyboard')

            # The reader opens the folders of a source in the rail without leaving the page. One root read each.
            before = len(requests)
            await page.locator('.rail-row[data-row="source hermes"] .tree-toggle').focus()
            await page.keyboard.press('Enter')
            hermes_tree = page.locator('.rail-row[data-row="source hermes"] + .rail-tree')
            await expect(hermes_tree.locator('a').first).to_be_visible()
            await expect(page.locator('.rail-row[data-row="source hermes"] .tree-toggle')).to_be_focused()
            assert requests[before:] == ['/api/sources/hermes/browse?path='], requests[before:]
            assert await page.evaluate('location.hash') in ('', '#/')
            # A deeper level loads when its control opens it. Arrow keys open and close a level.
            await page.keyboard.press('ArrowDown')
            await page.keyboard.press('ArrowRight')
            nested = hermes_tree.locator('.rail-tree a')
            await expect(nested.first).to_be_visible()
            first_folder = fixtures['browse']['hermes']['']['folders'][0]
            assert requests[before + 1:] == ['/api/sources/hermes/browse?path=' + first_folder['path']], requests[before:]
            assert await nested.evaluate_all('(nodes) => nodes.map(n => new URLSearchParams(n.getAttribute("href").split("?")[1]).get("path"))') == [
                folder['path'] for folder in fixtures['browse']['hermes'][first_folder['path']]['folders']]
            await page.keyboard.press('ArrowLeft')
            await expect(nested).to_have_count(0)
            # The lazy source lists its namespaces from the root read alone. No namespace has a control to open it.
            before = len(requests)
            await page.locator('.rail-row[data-row="source agentcore"] .tree-toggle').click()
            lazy_tree = page.locator('.rail-row[data-row="source agentcore"] + .rail-tree')
            await expect(lazy_tree.locator('a')).to_have_count(len(scenario['namespaces']))
            await expect(lazy_tree.locator('.tree-toggle')).to_have_count(0)
            assert requests[before:] == ['/api/sources/agentcore/browse?path='], requests[before:]
            await page.locator('.rail-row[data-row="source hermes"] .tree-toggle').click()
            await page.locator('.rail-row[data-row="source agentcore"] .tree-toggle').click()
            passed('Rail folders load on request only, level by level; a lazy source reads its root alone')
            colors = await page.locator('.strata-seg.src-openviking').evaluate_all('(nodes) => nodes.map(n => getComputedStyle(n).backgroundColor)')
            assert len(colors) == 2 and colors[0] == colors[1]
            assert await page.locator('.strata-bar').evaluate('(n) => getComputedStyle(n).gap') == '2px'
            await expect(page.locator('.ledger .src-agentcore .state-word')).to_have_text('On request')
            await expect(page.locator('.ledger .src-hermes .state-word')).to_have_text('Error')
            await expect(page.locator('.ledger .src-llmwiki .partial')).to_be_visible()
            await expect(page.locator('.timeline .item-link').first).to_be_visible()
            passed('Grouping, repeated hues, separate strata segments, lazy ledger and isolated source error')

            stale = next(source for source in fixtures['overview'] if source['state'] == 'stale')
            stale_row = page.locator(f'.ledger .src-{stale["type"]}')
            await expect(stale_row.locator('.state-word')).to_have_text('Stale')
            await expect(stale_row).to_contain_text(stale['error']['message'])
            await expect(stale_row).to_contain_text(stale['detail'])
            await expect(stale_row.locator('.num')).to_have_text(str(stale['total']))
            await expect(page.locator(f'.strata-seg.src-{stale["type"]}')).to_be_visible()
            for name, path, selector in [('folders', '', '.rail-tree a'), ('entries', 'inbox/triage', '.list-col .item-link')]:
                hold['overview'], entered['overview'] = asyncio.Event(), asyncio.Event()
                await page.goto(base + '/#/source/okknow?path=' + path)
                await asyncio.wait_for(entered['overview'].wait(), 5)
                await expect(page.locator('.path-bar .crumbs')).to_be_visible()
                await expect(page.locator(selector).first).to_be_visible()
                await settled()
                assert not hold['overview'].is_set()
                overview_proof[name + '_visible_before_overview_release'] = True
                screenshot = name + '-before-overview.png'
                await page.screenshot(path=str(output / screenshot), full_page=True)
                screenshots.append(screenshot)
                hold.pop('overview').set()
                await expect(page.locator('.source-head .stale-notice')).to_contain_text(stale['error']['message'])
            overview_proof['stale_notice_after_release'] = True
            passed('Healthy source entries and folder crumbs paint while overview is held; status arrives later')

            # A status reply from the prior source must not reach the current view.
            for refused in (False, True):
                await go('#/', '.ledger')
                if refused:
                    fail.add('overview')
                hold['overview'], entered['overview'] = asyncio.Event(), asyncio.Event()
                await page.goto(base + '/#/source/okknow?path=inbox/triage')
                await asyncio.wait_for(entered['overview'].wait(), 5)
                await expect(page.locator('.list-col .item-link').first).to_be_visible()
                pending = hold.pop('overview')
                fail.discard('overview')
                await page.locator('.sources-nav .rail-sub a').first.click()
                await expect(page.locator('.rail-tree a').first).to_be_visible()
                await settled()
                async with page.expect_response(lambda response: urlparse(response.url).path == '/api/overview') as reply:
                    pending.set()
                await (await reply.value).body()
                await page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
                await expect(page.locator('.source-head h1')).to_have_text(fixtures['sources'][0]['name'])
                await expect(page.locator('.source-head .stale-notice, .source-head [role="alert"]')).to_have_count(0)
            overview_proof['late_status_and_failure_leave_new_source_unchanged'] = True
            passed('Late overview success and failure cannot change another source view')
            await go(f'#/source/{stale["id"]}', '.stale-notice')
            await settled()
            await expect(page.locator('.source-head .stale-notice')).to_contain_text(stale['error']['message'])
            await expect(page.locator('.source-head .stale-notice')).to_contain_text(stale['detail'])
            await expect(page.locator('.rail-tree a').first).to_be_visible()
            await page.locator('.rail-tree a').first.click()
            await settled()
            await page.locator('.rail-tree .rail-tree a').first.click()
            await expect(page.locator('.list-col .item-link').first).to_be_visible()
            await go(f'#/source/{stale["id"]}?path=inbox/triage', '.stale-notice')
            await settled()
            await expect(page.locator('.stale-notice .state-word')).to_have_text('Stale')
            await expect(page.locator('.stale-notice')).to_contain_text(str(stale['total']))
            await expect(page.locator('.list-col .item-link').first).to_be_visible()
            passed('Stale ledger and direct source view retain counts, data, detail and public errors')
            await go('#/', '.ledger')

            await page.keyboard.press('Tab')
            await page.locator('.skip').focus()
            await page.keyboard.press('Enter')
            await expect(page.locator('#main')).to_be_focused()
            assert await page.evaluate('location.hash') == '#/'
            await page.keyboard.press('/')
            await expect(page.locator('#search-input')).to_be_focused()
            await page.locator('#search-input').fill('gateway')
            await page.keyboard.press('Enter')
            await expect(page.locator('.group')).to_have_count(5)
            await expect(page.locator('.filter.src-agentcore')).to_have_attribute('aria-pressed', 'false')
            filters = await page.locator('.filter').all_text_contents()
            assert 'Alice' in filters[0] and 'Bob' in filters[1]
            await expect(page.locator('.group.src-openviking .partial').first).to_be_visible()
            await expect(page.locator('.group.src-openviking .more').first).to_be_visible()
            await expect(page.locator('.group.src-llmwiki')).to_contain_text('No match.')
            await expect(page.locator('.group.src-hermes [role="alert"]')).to_be_visible()
            assert 'agentcore' not in next(request for request in reversed(requests) if request.startswith('/api/search?'))
            passed('Search defaults, grouped results, partial/more/notes, empty and failed groups')

            hold['search'], entered['search'] = asyncio.Event(), asyncio.Event()
            await page.locator('.filter.src-agentcore').focus()
            await page.keyboard.press('Space')
            await asyncio.wait_for(entered['search'].wait(), 5)
            await expect(page.locator('.results-col .loading')).to_be_visible()
            await expect(page.locator('.filter.src-agentcore')).to_be_focused()
            hold.pop('search').set()
            await expect(page.locator('.group')).to_have_count(6)
            await expect(page.locator('.filter.src-agentcore')).to_be_focused()
            assert await page.locator('.filter.src-agentcore').evaluate('(n) => getComputedStyle(n).outlineStyle') == 'solid'
            for error in scenario['search']['agentcore']['errors']:
                notice = page.locator('.group.src-agentcore .namespace-errors li').filter(has_text=error['path'])
                await expect(notice).to_contain_text(error['message'])
            await expect(page.locator('.group.src-openviking .item-link').first).to_be_visible()
            passed('Grouped search names every failed namespace and retains other source results')
            await page.keyboard.press('Space')
            await expect(page.locator('.group')).to_have_count(5)
            passed('Keyboard filter activation and focus survive asynchronous search updates')

            before = len(requests)
            await go('#/search?q=gateway&s=', '.notice')
            await expect(page.locator('#main')).to_contain_text('No sources selected.')
            await go('#/search', '.results-col .notice')
            await expect(page.locator('.results-col')).to_contain_text('Enter a search term.')
            assert not any(request.startswith('/api/search?') for request in requests[before:])
            passed('Explicit empty selection and missing search term send no search request')

            before = len(requests)
            await go('#/source/agentcore', '.load-label')
            await settled()
            for request in requests[before:]:
                url = urlparse(request)
                if url.path.startswith('/api/sources/agentcore/'):
                    assert url.path.endswith('/browse'), request
                    assert parse_qs(url.query).get('path', [''])[0] == '', request
            for folder in scenario['namespaces']:
                link = page.locator('.rail-tree a').filter(has_text=folder['label'])
                if folder.get('state') and folder['state'] != 'unloaded':
                    await expect(link.locator('.load-label')).to_have_count(0)
                    await expect(link.locator('.namespace-state')).to_contain_text(folder['state'].capitalize())
                else:
                    await expect(link.locator('.load-label')).to_be_visible()
                if folder.get('error'):
                    await expect(link).to_contain_text(folder['error']['message'])
            passed('Loaded, empty, partial, denied, failed and unloaded namespaces stay distinct without automatic namespace reads')
            await expect(page.locator('.list-col')).to_contain_text('No records load')
            await expect(page.locator('.item-link')).to_have_count(0)
            await page.locator('.rail-tree a').first.click()
            await expect(page.locator('.list-col .item-link')).to_have_count(1)
            await page.locator('.item-link').click()
            await expect(page.locator('#reader-title')).to_be_visible()
            await expect(page.locator('.service-text')).to_contain_text('ISO 8601')
            await page.keyboard.press('Escape')
            await expect(page.locator('.reader-col')).to_be_empty()
            await expect(page.locator('.item-link')).to_be_focused()
            passed('Lazy namespace load action reads synthetic data; Escape restores the list focus')

            await go('#/source/agentcore?q=gateway', '.namespace-errors')
            await settled()
            for error in scenario['search']['agentcore']['errors']:
                await expect(page.locator('.list-col .namespace-errors')).to_contain_text(error['path'])
                await expect(page.locator('.list-col .namespace-errors')).to_contain_text(error['message'])
            fail.add('overview')
            await go('#/source/okknow?path=inbox/triage', '.source-head [role="alert"]')
            await settled()
            await expect(page.locator('.list-col .item-link').first).to_be_visible()
            fail.remove('overview')
            passed('Scoped namespace errors remain visible; failed source status does not hide browse data')

            for folder in (folder for folder in scenario['namespaces'] if folder.get('error')):
                await go('#/source/agentcore?path=' + folder['path'], '.list-col [role="alert"]')
                await settled()
                await expect(page.locator('.path-bar .crumbs')).to_contain_text(folder['label'])
                await expect(page.locator('.list-col [role="alert"]')).to_contain_text(folder['error']['message'])
                await expect(page.locator('.rail-tree a[aria-current]')).to_contain_text(folder['state'].capitalize())
                await expect(page.locator('.rail-tree a[aria-current]')).to_contain_text(folder['error']['message'])
                await expect(page.locator('.rail-tree a').filter(has_text=scenario['namespaces'][0]['label'])).to_be_visible()
                name = f'namespace-{folder["state"]}.png'
                await page.screenshot(path=str(output / name), full_page=True)
                screenshots.append(name)
            passed('Denied and failed namespace reads preserve namespace navigation, crumbs and refusal messages')

            await go('#/source/openviking?path=preferences', '.list-col .item-link')
            await page.get_by_role('link', name='Next page', exact=True).click()
            await expect(page.locator('.list-col .item-link')).to_have_text('Dashboard style')
            await page.locator('.item-link').click()
            await expect(page.locator('#reader-title')).to_have_text('Dashboard style')
            before = len(requests)
            await page.keyboard.press('Escape')
            await expect(page.locator('.reader-col')).to_be_empty()
            assert 'offset=1' in await page.evaluate('location.hash')
            assert len(requests) == before
            await page.get_by_role('link', name='Previous page', exact=True).click()
            await expect(page.locator('.item-link')).to_have_text('Deployment safety')
            await go('#/source/openviking?path=sample-empty', '.list-col')
            await settled()
            await expect(page.locator('.list-col')).to_contain_text('This folder is empty.')
            passed('Pagination, retained reader offset, no reader-close reread and empty folder')

            # A nested folder: the rail opens each level above it, and each part of the path bar links to its own folder.
            deep = next(path for path in fixtures['browse']['hermes'] if '/' in path and fixtures['browse']['hermes'][path]['items'])
            crumbs = fixtures['browse']['hermes'][deep]['crumbs'][1:]
            await go('#/source/hermes?path=' + deep, '.list-col .item-link')
            await settled()
            await expect(page.locator('.rail-tree a[aria-current]')).to_have_attribute('title', crumbs[-1]['label'])
            assert await page.locator('.rail-tree a[aria-current]').evaluate('(n) => n.closest(".rail-tree").parentElement.closest(".rail-tree") !== null')
            bar = page.locator('.path-bar .crumbs a')
            await expect(bar).to_have_count(len(crumbs) + 1)
            assert await bar.evaluate_all('(nodes) => nodes.map(n => n.getAttribute("href"))') == ['#/source/hermes'] + [
                '#/source/hermes?' + urlencode({'path': crumb['path']}) for crumb in crumbs]
            await expect(page.locator('.path-bar [aria-current]')).to_have_text(crumbs[-1]['label'])
            await page.locator('.list-col .item-link').first.click()
            await expect(page.locator('#reader-title')).to_be_visible()
            await expect(page.locator('.path-bar [aria-current]')).to_have_text(await page.locator('#reader-title').inner_text())
            await page.screenshot(path=str(output / 'path-bar-entry-1440.png'), full_page=True)
            screenshots.append('path-bar-entry-1440.png')
            await page.keyboard.press('Escape')
            await expect(page.locator('.path-bar [aria-current]')).to_have_text(crumbs[-1]['label'])
            await bar.nth(1).click()
            await expect(page.locator('.path-bar [aria-current]')).to_have_text(crumbs[0]['label'])
            assert parse_qs(urlparse(await page.evaluate('location.hash.slice(1)')).query)['path'] == [crumbs[0]['path']]
            passed('Nested folder: the rail shows each level, the path bar links each part to its folder and ends with the open entry')

            # A folder reply for a source that is no longer current reaches neither the rail nor the content.
            hold['browse'], entered['browse'] = asyncio.Event(), asyncio.Event()
            await page.goto(base + '/#/source/llmwiki?path=wiki')
            await asyncio.wait_for(entered['browse'].wait(), 5)
            pending = hold.pop('browse')
            entered.pop('browse')
            await page.locator('.sources-nav a.src-okknow').click()
            await expect(page.locator('.rail-row[data-row="source okknow"] + .rail-tree a').first).to_be_visible()
            await settled()
            async with page.expect_response(lambda response: urlparse(response.url).path.endswith('/llmwiki/browse')) as reply:
                pending.set()
            await (await reply.value).body()
            await page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
            await expect(page.locator('.rail-row[data-row="source llmwiki"] + .rail-tree')).to_have_count(0)
            await expect(page.locator('.path-bar .crumbs a')).to_have_count(1)
            await expect(page.locator('.path-bar .crumbs a')).to_have_attribute('href', '#/source/okknow')
            passed('Late folder reply of another source paints into neither the rail nor the path bar')

            # A group that the reader closed stays closed while the rail redraws for the same source.
            await go('#/source/openviking-bob', '.list-col')
            await settled()
            group_toggle = page.locator('.rail-group.src-openviking .rail-group-toggle')
            await expect(group_toggle).to_have_attribute('aria-expanded', 'true')
            await group_toggle.click()
            await page.locator('#source-q').fill('gateway')
            await page.keyboard.press('Enter')
            await expect(page.locator('.path-note')).to_be_visible()
            await settled()
            await expect(page.locator('.rail-group.src-openviking .rail-group-toggle')).to_have_attribute('aria-expanded', 'false')
            await go('#/', '.ledger')
            await page.locator('.ledger .src-name', has_text='Bob').click()
            await expect(page.locator('.rail-group.src-openviking .rail-group-toggle')).to_have_attribute('aria-expanded', 'true')
            passed('A closed provider group stays closed on a redraw and opens again when a route enters one of its sources')

            await go('#/source/openviking-bob?path=preferences&item=sample-bob-reports', '#reader-title')
            await expect(page.locator('.private')).to_have_text('private value')
            await page.get_by_role('button', name='Show raw text', exact=True).click()
            await expect(page.locator('pre.raw')).to_contain_text('{{ov_privacy:sample:')
            await page.get_by_role('button', name='Show formatted', exact=True).click()
            await expect(page.locator('.service-meta')).to_be_visible()
            await expect(page.locator('.app-labels')).to_be_visible()
            await page.evaluate("Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async text => {window.copied = text;}}})")
            await page.get_by_role('button', name='Copy text', exact=True).click()
            await expect(page.get_by_role('button', name='Copied', exact=True)).to_be_visible()
            assert await page.evaluate('window.copied') == fixtures['entries']['openviking-bob']['sample-bob-reports']['body']
            await page.evaluate("() => {navigator.clipboard.writeText = async () => {throw new Error('Synthetic clipboard refusal');};}")
            await page.get_by_role('button', name='Copied', exact=True).click()
            await expect(page.get_by_role('button', name='Copy is not available', exact=True)).to_be_visible()
            passed('Reader formatted/raw text, separate metadata, copy success and clipboard refusal')

            # A held list must still settle after Escape; reader navigation must not repeat it.
            hold['browse'], entered['browse'] = asyncio.Event(), asyncio.Event()
            hold['item'], entered['item'] = asyncio.Event(), asyncio.Event()
            await page.goto(base + '/#/source/openviking?path=preferences&item=sample-ov-pref-deploy')
            await asyncio.wait_for(entered['browse'].wait(), 5)
            await asyncio.wait_for(entered['item'].wait(), 5)
            await expect(page.locator('.reader .loading')).to_be_visible()
            before = len([request for request in requests if '/browse?' in request])
            await page.keyboard.press('Escape')
            await expect(page.locator('.reader-col')).to_be_empty()
            hold.pop('browse').set()
            hold.pop('item').set()
            await settled()
            await expect(page.locator('.item-link')).to_have_text('Deployment safety')
            assert len([request for request in requests if '/browse?' in request]) == before
            await expect(page.locator('.reader-col')).to_be_empty()
            passed('Pending reader Escape leaves the list request alive without a duplicate read')

            hold['item'], entered['item'] = asyncio.Event(), asyncio.Event()
            await page.locator('.item-link').click()
            await asyncio.wait_for(entered['item'].wait(), 5)
            await page.locator('#search-input').focus()
            hold.pop('item').set()
            await expect(page.locator('#reader-title')).to_be_visible()
            await expect(page.locator('#search-input')).to_be_focused()
            passed('Late reader completion does not steal focus')

            await page.keyboard.press('Escape')
            await expect(page.locator('.reader-col')).to_be_empty()
            hold['item'], entered['item'] = asyncio.Event(), asyncio.Event()
            await page.locator('.item-link').click()
            await asyncio.wait_for(entered['item'].wait(), 5)
            await page.locator('.sources-nav a.src-okknow').click()
            await expect(page.locator('.source-head h1')).to_have_text('okknow')
            hold.pop('item').set()
            await settled()
            await expect(page.locator('.reader-col')).to_be_empty()
            await expect(page.locator('.sources-nav a.src-okknow')).to_be_focused()
            passed('Stale reader completion cannot replace a new source view; navigation retains focus')

            for part, hash, selector in [
                ('sources', '#/', '#main'), ('overview', '#/', '.ledger'), ('recent', '#/', '.recent'),
                ('search', '#/search?q=gateway', '.results-col'),
                ('browse', '#/source/openviking', '.list-col'),
                ('item', '#/source/openviking?item=sample-ov-profile', '.reader-col'),
            ]:
                fail.add(part)
                await page.goto(base + '/' + hash)
                await page.reload()
                await expect(page.locator(selector)).to_contain_text(scenario['errors'][part])
                await expect(page.locator('.top')).to_be_visible()
                if part == 'sources':
                    fail.remove(part)
                    await page.get_by_role('button', name='Try again', exact=True).click()
                    await expect(page.locator('.ledger')).to_be_visible()
                else:
                    fail.remove(part)
            passed('Failure probes: sources/retry, overview, recent, global search, browse and reader')

            fail.add('search')
            await go('#/source/openviking?q=gateway', '.list-col [role="alert"]')
            await expect(page.locator('.rail-tree a').first).to_be_visible()
            await page.set_viewport_size({'width': 400, 'height': 1000})
            await go('#/search?q=gateway&open=openviking&item=sample-ov-profile', '#reader-title')
            await page.locator('.close').click()
            await expect(page.locator('.results-col [role="alert"]')).to_be_visible()
            fail.remove('search')
            await page.set_viewport_size({'width': 1440, 'height': 1000})
            passed('Failed scoped search keeps folders; failed search deep links keep the mobile reader and back action')

            empty = fixtures['browse']['openviking'][scenario['emptyFolder']]
            empty.update(total=1, partial=True, more=True)
            hold['browse'], entered['browse'] = asyncio.Event(), asyncio.Event()
            await page.goto(base + '/#/source/openviking?path=sample-empty')
            await asyncio.wait_for(entered['browse'].wait(), 5)
            await expect(page.locator('.list-col .loading')).to_be_visible()
            hold.pop('browse').set()
            await settled()
            await expect(page.locator('.list-col')).to_contain_text('This partial read returned no entries.')
            await expect(page.locator('.list-col')).to_contain_text('The source reports more entries but returned no page.')
            empty.update(total=0, partial=False, more=False)
            saved_overview, saved_recent = fixtures['overview'], fixtures['recent']
            fixtures['overview'], fixtures['recent'] = [], []
            await go('#/', '.ledger')
            await expect(page.locator('.ledger')).to_contain_text('No sources are configured.')
            await expect(page.locator('.recent')).to_contain_text('No dated entries.')
            await expect(page.locator('.strata')).to_contain_text('No source has a count yet.')
            fixtures['overview'], fixtures['recent'] = saved_overview, saved_recent
            row = next(source for source in fixtures['overview'] if source['id'] == 'openviking-bob')
            saved_total = row['total']
            row.update(state='loading', total=None)
            await page.get_by_role('button', name='Read again', exact=True).click()
            await expect(page.locator('.ledger .src-openviking .state-word').nth(1)).to_have_text('Loading')
            row.update(state='ok', total=0)
            await page.get_by_role('button', name='Read again', exact=True).click()
            await expect(page.locator('.ledger .src-openviking .state-word').nth(1)).to_have_text('Empty')
            row['total'] = saved_total
            passed('Empty ledger/recent/strata, source loading, empty source and empty partial read')

            await go('#/source/unknown', '#main [role="alert"]')
            await expect(page.locator('#main')).to_contain_text('No source has this id.')
            await go('#/source/%E0%A4%A', '#main [role="alert"]')
            await expect(page.get_by_role('link', name='Back to all sources', exact=True)).to_be_visible()
            await go('#/source/agentcore?path=unknown', '.list-col [role="alert"]')
            await expect(page.locator('.list-col')).to_contain_text('No sample namespace has this path.')
            await go('#/source/openviking?item=sample-missing', '.reader-col [role="alert"]')
            await expect(page.locator('.reader-col')).to_contain_text('No sample item has this id.')
            await expect(page.locator('.close')).to_be_visible()
            plain_error.add('search')
            await go('#/search?q=gateway', '.results-col [role="alert"]')
            await expect(page.locator('.results-col')).to_contain_text('HTTP 502')
            plain_error.remove('search')
            await page.reload()
            await expect(page.locator('.group')).to_have_count(5)
            passed('Failure probes: unknown source, malformed route, unavailable namespace, missing item and non-JSON HTTP error')

            await go('#/search?q=gateway', '.group')
            links = page.locator('.group.src-openviking').nth(1).locator('.item-link')
            await links.first.focus()
            await page.keyboard.press('ArrowDown')
            await expect(links.nth(1)).to_be_focused()
            await page.keyboard.press('Home')
            await expect(links.first).to_be_focused()
            await page.keyboard.press('End')
            await expect(links.nth(1)).to_be_focused()
            await page.keyboard.press('ArrowUp')
            await expect(links.first).to_be_focused()
            passed('Arrow/Home/End navigation stays within the current list')

            # A small screen hides the rail behind its toggle. Escape and a chosen source close it.
            await page.set_viewport_size({'width': 400, 'height': 1000})
            await go('#/', '.ledger')
            await expect(page.locator('.sources-nav')).to_be_hidden()
            await page.locator('#rail-toggle').click()
            await expect(page.locator('.sources-nav .rail-sub a').first).to_be_visible()
            await page.locator('.sources-nav .rail-sub a').first.focus()
            await page.keyboard.press('Escape')
            await expect(page.locator('.sources-nav')).to_be_hidden()
            await expect(page.locator('#rail-toggle')).to_be_focused()
            await page.keyboard.press('Enter')
            # Opening the rail moves the focus into it, so the next Tab stays in the rail.
            assert await page.evaluate('document.getElementById("sources-nav").contains(document.activeElement)')
            await page.locator('.sources-nav a.src-okknow').click()
            await expect(page.locator('.source-head h1')).to_have_text('okknow')
            await expect(page.locator('.sources-nav')).to_be_hidden()
            await expect(page.locator('#main')).to_be_focused()
            await page.locator('#rail-toggle').click()
            # The collapsed rail still gives the folders of the current source.
            await expect(page.locator('.sources-nav .rail-tree a').first).to_be_visible()
            await page.screenshot(path=str(output / 'rail-open-400.png'), full_page=True)
            screenshots.append('rail-open-400.png')
            passed('Small screen: the rail opens from its toggle with the focus and the folders in it, closes on Escape and on a chosen source')

            for width in (1440, 400):
                await page.set_viewport_size({'width': width, 'height': 1000})
                for theme in ('light', 'dark'):
                    for view, hash, ready in [
                        ('global', '#/', '.ledger'),
                        ('search', '#/search?q=gateway', '.group'),
                        ('source', '#/source/agentcore', '.path-bar'),
                        ('stale-ledger', '#/', '.ledger .state-error'),
                        ('stale-source', '#/source/okknow?path=inbox/triage', '.stale-notice'),
                        ('namespace-errors', '#/search?q=gateway&s=agentcore,openviking', '.namespace-errors'),
                        ('namespace-states', '#/source/agentcore', '.path-bar'),
                        ('reader', '#/source/openviking-bob?path=entities&item=sample-bob-gateway', '#reader-title'),
                    ]:
                        await go(hash, ready)
                        await settled()
                        await page.locator('#theme').select_option(theme)
                        if view == 'namespace-states':
                            # On a small screen the namespaces and their states sit in the rail behind its toggle.
                            if width == 400:
                                await page.locator('#rail-toggle').click()
                            await expect(page.locator('.rail-tree .namespace-state').first).to_be_visible()
                            await expect(page.locator('.rail-tree .load-label').first).to_be_visible()
                        if not await page.evaluate('document.documentElement.scrollWidth <= innerWidth'):
                            await page.screenshot(path=str(output / 'overflow-probe.png'), full_page=True)
                            overflow = await page.locator('body *').evaluate_all('(nodes) => nodes.filter(n => n.getBoundingClientRect().right > innerWidth).map(n => [n.tagName, n.className, n.getBoundingClientRect().right])')
                            raise AssertionError((width, theme, view, overflow))
                        if view == 'reader':
                            assert await page.locator('.reader').evaluate('(n) => getComputedStyle(n).animationName') == 'none'
                            if width == 400:
                                await expect(page.locator('.list-col')).to_be_hidden()
                                await expect(page.locator('.path-bar')).to_be_visible()
                                await expect(page.locator('.close')).to_be_visible()
                        await page.evaluate('scrollTo(0, 0)')
                        name = f'{view}-{theme}-{width}.png'
                        await page.screenshot(path=str(output / name), full_page=True)
                        screenshots.append(name)
            await page.set_viewport_size({'width': 900, 'height': 1000})
            await go('#/source/openviking-bob?path=entities&item=sample-bob-gateway', '#reader-title')
            await expect(page.locator('.list-col')).to_be_hidden()
            await page.locator('.close').click()
            await expect(page.locator('.list-col')).to_be_visible()
            passed('Light/dark screenshots at 1440/400; no page overflow; reader page at 400/900; reduced motion')

            await page.add_init_script("Object.defineProperty(window, 'localStorage', {get() {throw new Error('Synthetic storage refusal');}})")
            await page.reload()
            await expect(page.locator('.list-col')).to_be_visible()
            await expect(page.locator('#theme')).to_have_value('light')
            await page.locator('#theme').select_option('dark')
            await expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
            passed('Unavailable local storage falls back to the light theme and still allows theme changes')

            assert not errors, errors
            assert not external, external
            assert not csp_errors, csp_errors
            passed('No JavaScript errors, external page requests, CSP violations or non-GET API requests')
            report = {'checks': results, 'screenshots': screenshots, 'requests': len(requests), 'browser': browser.version,
                      'overview_proof': overview_proof}
            (output / 'browser-evidence.json').write_text(json.dumps(report, indent=2) + '\n')
            print(f'browser-check: PASS ({len(results)} checks, {len(screenshots)} screenshots)')
        finally:
            for event in hold.values():
                event.set()
            await context.close()
            await browser.close()


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: browser-check.py BASE_URL EVIDENCE_DIRECTORY')
    asyncio.run(check(sys.argv[1].rstrip('/'), Path(sys.argv[2])))
