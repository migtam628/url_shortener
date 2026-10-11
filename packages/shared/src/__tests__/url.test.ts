import { describe, it, expect } from 'vitest';
import {
  applyUtm,
  extractUtm,
  isPrivateAddress,
  normalizeHostname,
  referrerHost,
  validateDestination,
} from '../url.js';

describe('isPrivateAddress', () => {
  it('flags IPv4 private, loopback and link-local space', () => {
    for (const ip of [
      '127.0.0.1', '127.1.2.3', '10.0.0.1', '10.255.255.255',
      '172.16.0.1', '172.31.255.254', '192.168.1.1',
      '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '255.255.255.255',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('allows public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '192.167.1.1', '93.184.216.34']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('flags IPv6 loopback, link-local, ULA and IPv4-mapped loopback', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', 'ff02::1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('allows public IPv6', () => {
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
  });
});

describe('validateDestination — SSRF guard', () => {
  // These are the exact cases named in the project acceptance criteria.
  it('rejects the acceptance-criteria targets', () => {
    for (const url of [
      'http://127.0.0.1',
      'http://127.0.0.1:8080/admin',
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost',
      'http://localhost:4000/api/v1/links',
      'https://metadata.google.internal/computeMetadata/v1/',
    ]) {
      const r = validateDestination(url);
      expect(r.ok, url).toBe(false);
    }
  });

  it('rejects internal TLDs and bare hostnames', () => {
    for (const url of [
      'http://intranet',
      'http://nas.local',
      'http://db.internal',
      'http://printer.lan',
      'http://router.home.arpa',
      'http://site.localhost',
    ]) {
      expect(validateDestination(url).ok, url).toBe(false);
    }
  });

  it('rejects non-http protocols', () => {
    for (const url of [
      'file:///etc/passwd',
      'ftp://example.com',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'gopher://example.com',
    ]) {
      expect(validateDestination(url).ok, url).toBe(false);
    }
  });

  it('rejects embedded credentials', () => {
    expect(validateDestination('https://user:pass@example.com').ok).toBe(false);
  });

  it('rejects relative and malformed input', () => {
    for (const url of ['/just/a/path', 'example.com', '', '   ', 'http://']) {
      expect(validateDestination(url).ok, JSON.stringify(url)).toBe(false);
    }
  });

  it('accepts ordinary public destinations', () => {
    for (const url of [
      'https://example.com',
      'https://example.com/path?a=1&b=2#frag',
      'http://sub.example.co.uk:8080/x',
    ]) {
      expect(validateDestination(url).ok, url).toBe(true);
    }
  });

  it('allows private targets only when explicitly opted in', () => {
    expect(validateDestination('http://127.0.0.1:3000', { allowPrivate: true }).ok).toBe(true);
  });
});

describe('validateDestination — redirect loop guard', () => {
  const shortDomains = ['mt.lc', 'go.mttech.io'];

  it('rejects a destination on one of our own short domains', () => {
    for (const url of ['https://mt.lc/abc123', 'https://www.mt.lc/x', 'https://go.mttech.io/y']) {
      expect(validateDestination(url, { shortDomains }).ok, url).toBe(false);
    }
  });

  it('allows lookalike domains that are not ours', () => {
    expect(validateDestination('https://notmt.lc/abc', { shortDomains }).ok).toBe(true);
    expect(validateDestination('https://mt.lc.evil.com/abc', { shortDomains }).ok).toBe(true);
  });
});

describe('validateDestination — normalization', () => {
  it('lowercases scheme and host but preserves path case', () => {
    const r = validateDestination('HTTPS://Example.COM/Path/To/Thing');
    expect(r.ok && r.url).toBe('https://example.com/Path/To/Thing');
  });

  it('drops default ports only', () => {
    expect(validateDestination('https://example.com:443/a').ok && validateDestination('https://example.com:443/a')).toMatchObject({ url: 'https://example.com/a' });
    const custom = validateDestination('https://example.com:8443/a');
    expect(custom.ok && custom.url).toBe('https://example.com:8443/a');
  });

  it('preserves query order and fragments exactly', () => {
    const src = 'https://example.com/p?z=1&a=2&sig=AbC%2FdEf%3D#section-2';
    const r = validateDestination(src);
    expect(r.ok && r.url).toBe(src);
  });
});

describe('UTM helpers', () => {
  it('adds parameters without disturbing existing query', () => {
    const out = applyUtm('https://example.com/p?id=7', { source: 'qr', medium: 'print' });
    const q = new URL(out).searchParams;
    expect(q.get('id')).toBe('7');
    expect(q.get('utm_source')).toBe('qr');
    expect(q.get('utm_medium')).toBe('print');
  });

  it('replaces an existing utm value and removes on empty string', () => {
    const replaced = applyUtm('https://example.com?utm_source=old', { source: 'new' });
    expect(new URL(replaced).searchParams.get('utm_source')).toBe('new');
    const removed = applyUtm('https://example.com?utm_source=old', { source: '' });
    expect(new URL(removed).searchParams.has('utm_source')).toBe(false);
  });

  it('round-trips through extractUtm', () => {
    const utm = { source: 'fieldnation', medium: 'email', campaign: 'q4' };
    expect(extractUtm(applyUtm('https://example.com', utm))).toEqual(utm);
  });
});

describe('host helpers', () => {
  it('normalizes Host headers', () => {
    expect(normalizeHostname('Go.MT.LC:8443')).toBe('go.mt.lc');
    expect(normalizeHostname('[2606:4700::1111]:443')).toBe('[2606:4700::1111]');
    expect(normalizeHostname('')).toBeNull();
    expect(normalizeHostname(undefined)).toBeNull();
  });

  it('extracts referrer hosts and tolerates junk', () => {
    expect(referrerHost('https://news.ycombinator.com/item?id=1')).toBe('news.ycombinator.com');
    expect(referrerHost('not a url')).toBeNull();
    expect(referrerHost(null)).toBeNull();
  });
});
