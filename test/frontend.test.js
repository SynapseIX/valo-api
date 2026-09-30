import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { mock, test } from 'node:test';

const sourceUrl = new URL('../public/assets/index.js', import.meta.url);
const source = await fs.readFile(sourceUrl, 'utf8');

function form({ protocol = 'https:', consent = true, region = 'na', fetchImpl } = {}) {
  let click;
  const elements = {
    '#connectButton': {
      disabled: false,
      addEventListener(event, listener) {
        assert.equal(event, 'click');
        click = listener;
      },
    },
    '#status': { textContent: '' },
    '#consent': { checked: consent },
    '#region': { value: region },
  };
  const assign = mock.fn();
  const fetch = fetchImpl || mock.fn(async () => { throw new Error('Unexpected network request'); });
  vm.runInNewContext(source, {
    document: {
      querySelector(selector) {
        assert.ok(elements[selector], `Unexpected selector: ${selector}`);
        return elements[selector];
      },
    },
    window: { location: { protocol, assign } },
    URL,
    fetch,
  }, { filename: sourceUrl.pathname });
  return {
    click: () => click(),
    button: elements['#connectButton'],
    status: elements['#status'],
    fetch,
    assign,
  };
}

test('direct HTML previews explain that sign-in needs the Node server', async () => {
  const app = form({ protocol: 'file:' });
  await app.click();
  assert.match(app.status.textContent, /npm start/);
  assert.match(app.status.textContent, /https:\/\/valo-api.synapseix.pro/);
  assert.equal(app.fetch.mock.callCount(), 0);
  assert.equal(app.assign.mock.callCount(), 0);
  assert.equal(app.button.disabled, false);
});

test('sign-in requires explicit consent before making a request', async () => {
  const app = form({ consent: false });
  await app.click();
  assert.match(app.status.textContent, /accept the data-sharing notice/);
  assert.equal(app.fetch.mock.callCount(), 0);
  assert.equal(app.assign.mock.callCount(), 0);
  assert.equal(app.button.disabled, false);
});

test('sign-in disables the button while loading and redirects only after a successful response', async () => {
  let complete;
  const pending = new Promise(resolve => { complete = resolve; });
  const fetchImpl = mock.fn(() => pending);
  const app = form({ fetchImpl, region: 'eu&extra=1' });
  const click = app.click();
  assert.equal(app.button.disabled, true);
  assert.equal(app.status.textContent, 'Preparing Riot sign-in…');
  assert.equal(app.assign.mock.callCount(), 0);
  const [url, options] = fetchImpl.mock.calls[0].arguments;
  assert.equal(url, '/auth/riot/start?region=eu%26extra%3D1');
  assert.equal(options.cache, 'no-store');
  const destination = 'https://auth.riotgames.com/authorize?state=fixture';
  complete(Response.json({ authorizationUrl: destination }));
  await click;
  assert.equal(app.assign.mock.calls[0].arguments[0], destination);
  assert.equal(app.button.disabled, true, 'Navigation is in progress');
});

test('API errors are displayed and the sign-in button becomes usable again', async () => {
  const app = form({
    fetchImpl: mock.fn(async () => Response.json(
      { error: { message: 'Set Riot production credentials first' } },
      { status: 503 },
    )),
  });
  await app.click();
  assert.equal(app.status.textContent, 'Set Riot production credentials first');
  assert.equal(app.button.disabled, false);
  assert.equal(app.assign.mock.callCount(), 0);
});

test('an API error without a message uses the fallback text', async () => {
  const app = form({ fetchImpl: mock.fn(async () => Response.json({}, { status: 502 })) });
  await app.click();
  assert.equal(app.status.textContent, 'Could not start sign-in');
  assert.equal(app.button.disabled, false);
});

for (const destination of [
  'https://example.com/login',
  'https://auth.riotgames.com.evil.example/login',
  'http://auth.riotgames.com/authorize',
  'javascript:alert(1)',
]) {
  test(`untrusted redirect is blocked: ${destination}`, async () => {
    const app = form({ fetchImpl: mock.fn(async () => Response.json({ authorizationUrl: destination })) });
    await app.click();
    assert.equal(app.status.textContent, 'Invalid authentication destination');
    assert.equal(app.assign.mock.callCount(), 0);
    assert.equal(app.button.disabled, false);
  });
}

test('missing or malformed redirect URLs cannot navigate the browser', async () => {
  for (const authorizationUrl of [undefined, '/authorize', 'not-a-url']) {
    const app = form({ fetchImpl: mock.fn(async () => Response.json({ authorizationUrl })) });
    await app.click();
    assert.ok(app.status.textContent.length > 0);
    assert.equal(app.assign.mock.callCount(), 0);
    assert.equal(app.button.disabled, false);
  }
});

test('network errors are shown and allow the user to retry', async () => {
  const app = form({ fetchImpl: mock.fn(async () => { throw new Error('Network unavailable'); }) });
  await app.click();
  assert.equal(app.status.textContent, 'Network unavailable');
  assert.equal(app.button.disabled, false);
  assert.equal(app.assign.mock.callCount(), 0);
});

test('invalid JSON responses do not leave the sign-in button disabled', async () => {
  const app = form({ fetchImpl: mock.fn(async () => new Response('not JSON')) });
  await app.click();
  assert.ok(app.status.textContent.length > 0);
  assert.equal(app.button.disabled, false);
  assert.equal(app.assign.mock.callCount(), 0);
});
