import { describe, expect, it } from 'vitest';
import { resolveInternalHref } from '../src/index.js';

/**
 * Links in the source are routes; the static export is files. Getting this
 * mapping wrong makes the links gate either useless (never fires) or unusable
 * (fires on every correct link).
 */
describe('internal href resolution', () => {
  it.each([
    ['/', 'index.html'],
    ['/services', 'services.html'],
    ['/services/', 'services.html'],
    ['/about/team', 'about/team.html'],
  ])('resolves the route %s to %s', (href, expected) => {
    expect(resolveInternalHref(href)).toBe(expected);
  });

  it('strips fragments and query strings before resolving', () => {
    expect(resolveInternalHref('/services#fitted')).toBe('services.html');
    expect(resolveInternalHref('/contact?ref=nav')).toBe('contact.html');
  });

  it('leaves an asset path alone apart from its leading slash', () => {
    // Next emits absolute asset URLs; the export root is what they resolve to.
    expect(resolveInternalHref('/_next/static/chunks/site.css')).toBe('_next/static/chunks/site.css');
    expect(resolveInternalHref('/favicon.ico')).toBe('favicon.ico');
  });

  it('returns null for an href with nothing to resolve', () => {
    expect(resolveInternalHref('#main')).toBe(null);
    expect(resolveInternalHref('')).toBe(null);
  });
});
