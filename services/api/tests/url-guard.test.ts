import { describe, it, expect } from 'vitest';
import { checkDestination } from '../src/services/links.js';
import { ApiError } from '../src/errors.js';

/**
 * The SSRF guard is the one piece of validation where a regression is a
 * security incident rather than a bug, so it is tested at the service
 * boundary as well as in the shared package.
 */
describe('checkDestination (service boundary)', () => {
  const blocked = [
    'http://127.0.0.1',
    'http://127.0.0.1:8080/admin',
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost',
    'http://localhost:4000/api/v1/links',
    'http://[::1]/',
    'http://10.0.0.5/internal',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://metadata.google.internal/',
    'http://db.internal',
    'http://nas.local',
    'http://intranet',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<script>',
    'https://user:pass@example.com/',
  ];

  for (const url of blocked) {
    it(`rejects ${url}`, () => {
      expect(() => checkDestination(url)).toThrow(ApiError);
    });
  }

  const allowed = [
    'https://example.com',
    'https://example.com/a/b?c=1#d',
    'http://sub.example.co.uk:8080/x',
    'https://www.fieldnation.com/workorders',
  ];

  for (const url of allowed) {
    it(`accepts ${url}`, () => {
      expect(() => checkDestination(url)).not.toThrow();
    });
  }

  it('normalizes without mangling the query string', () => {
    const signed = 'https://example.com/d?sig=AbC%2FdEf%3D&z=1&a=2';
    expect(checkDestination(signed)).toBe(signed);
  });
});
