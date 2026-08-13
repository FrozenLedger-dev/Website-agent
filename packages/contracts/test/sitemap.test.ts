import { describe, expect, it } from 'vitest';
import { HOME_ROUTE, Sitemap } from '../src/index.js';

const page = (route: string) => ({
  route,
  title: 'Title',
  metaDescription: 'A description.',
  goal: 'A goal.',
  primaryAction: 'Enquire',
  sections: [{ id: 's', heading: 'H', purpose: 'p', contentBindings: ['services'] }],
});

describe('sitemap', () => {
  it('accepts a plan with a homepage at the root', () => {
    const result = Sitemap.safeParse({ pages: [page('/'), page('/contact')] });
    expect(result.success).toBe(true);
  });

  it('rejects a plan with no homepage', () => {
    // A planner once nested every page under "about/faq/", so the site had no
    // entry point and 404'd at "/". The build succeeded and the gates then
    // raised ninety blocking findings — after a full build had been paid for.
    const result = Sitemap.safeParse({
      pages: [page('/about/faq'), page('/about/faq/contact')],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(HOME_ROUTE);
  });

  it('rejects duplicate routes', () => {
    const result = Sitemap.safeParse({ pages: [page('/'), page('/')] });
    expect(result.success).toBe(false);
  });

  it('normalises route forms before checking for the homepage', () => {
    // An empty or bare-slash route is the homepage however a model writes it.
    const result = Sitemap.safeParse({ pages: [page(''), page('services')] });
    expect(result.success).toBe(true);
    expect(result.data?.pages.map((p) => p.route)).toEqual(['/', '/services']);
  });

  it('does not accept "/index" as the homepage', () => {
    // A page literally routed at "/index" is a distinct page; the site would
    // still 404 at "/". Normalisation must not paper over that.
    const result = Sitemap.safeParse({ pages: [page('index')] });
    expect(result.success).toBe(false);
  });
});
