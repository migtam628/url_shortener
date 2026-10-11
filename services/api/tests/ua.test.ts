import { describe, it, expect } from 'vitest';
import { isBotUserAgent, parseLanguage, parseUserAgent } from '../src/lib/ua.js';
import { parseOg } from '../src/services/og.js';
import { parseCsv } from '../src/routes/csv.js';

describe('user agent parsing', () => {
  it('classifies real browsers', () => {
    const iphone = parseUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    );
    expect(iphone.deviceType).toBe('mobile');
    expect(iphone.os).toBe('iOS');
    expect(iphone.isBot).toBe(false);

    const desktop = parseUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    );
    expect(desktop.deviceType).toBe('desktop');
    expect(desktop.browser).toBe('Chrome');
  });

  it('flags crawlers, scrapers and monitors as bots', () => {
    for (const ua of [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'facebookexternalhit/1.1',
      'curl/8.4.0',
      'python-requests/2.31.0',
      'Slackbot-LinkExpanding 1.0',
      'UptimeRobot/2.0',
      'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0.0.0',
    ]) {
      expect(isBotUserAgent(ua), ua).toBe(true);
      expect(parseUserAgent(ua).deviceType).toBe('bot');
    }
  });

  it('treats a missing user agent as a bot', () => {
    expect(parseUserAgent(null).isBot).toBe(true);
    expect(parseUserAgent('').isBot).toBe(true);
  });
});

describe('Accept-Language parsing', () => {
  it('takes the first tag and drops the q-value', () => {
    expect(parseLanguage('es-US,es;q=0.9,en;q=0.8')).toBe('es-us');
    expect(parseLanguage('en-GB')).toBe('en-gb');
    expect(parseLanguage('*')).toBeNull();
    expect(parseLanguage(null)).toBeNull();
  });
});

describe('Open Graph parsing', () => {
  it('reads og: tags in either attribute order', () => {
    expect(
      parseOg('<meta property="og:title" content="Hello"><meta content="World" property="og:description">'),
    ).toMatchObject({ title: 'Hello', description: 'World' });
  });

  it('falls back to <title> and name="description"', () => {
    expect(parseOg('<title>Fallback</title><meta name="description" content="Desc">')).toMatchObject({
      title: 'Fallback',
      description: 'Desc',
    });
  });

  it('decodes HTML entities', () => {
    expect(parseOg('<title>Tom &amp; Jerry &#39;96</title>').title).toBe("Tom & Jerry '96");
  });

  it('returns nulls for markup with no metadata', () => {
    expect(parseOg('<html><body>nothing here</body></html>')).toEqual({
      title: null, description: null, image: null,
    });
  });
});

describe('CSV parsing', () => {
  it('handles quoted fields, escaped quotes and embedded commas', () => {
    const rows = parseCsv('a,b\n"x,1","he said ""hi"""\n');
    expect(rows).toEqual([['a', 'b'], ['x,1', 'he said "hi"']]);
  });

  it('handles CRLF and skips blank lines', () => {
    expect(parseCsv('a,b\r\n1,2\r\n\r\n3,4\r\n')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });

  it('handles a newline inside a quoted field', () => {
    expect(parseCsv('a,b\n"line1\nline2",2')).toEqual([['a', 'b'], ['line1\nline2', '2']]);
  });
});
