import { describe, expect, it } from 'vitest';
import { HOME_PAGE_PATH, Sitemap } from '../src/index.js';

const page = (path: string) => ({
  path,
  title: 'Title',
  metaDescription: 'A description.',
  goal: 'A goal.',
  primaryAction: 'Enquire',
  sections: [{ id: 's', heading: 'H', purpose: 'p', contentBindings: ['services'] }],
});

describe('sitemap', () => {
  it('accepts a plan with a homepage at the root', () => {
    const result = Sitemap.safeParse({ pages: [page('index.html'), page('contact.html')] });
    expect(result.success).toBe(true);
  });

  it('rejects a plan with no homepage', () => {
    // A planner once nested every page under "about/faq/", so the site had no
    // entry point and 404'd at "/". The build succeeded and the gates then
    // raised ninety blocking findings — after a full build had been paid for.
    const result = Sitemap.safeParse({
      pages: [page('about/faq/faq.html'), page('about/faq/contact.html')],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(HOME_PAGE_PATH);
  });

  it('rejects duplicate page paths', () => {
    const result = Sitemap.safeParse({ pages: [page('index.html'), page('index.html')] });
    expect(result.success).toBe(false);
  });

  it('normalises a leading slash before checking for the homepage', () => {
    // "/index.html" and "index.html" mean the same thing to a model.
    const result = Sitemap.safeParse({ pages: [page('/index.html')] });
    expect(result.success).toBe(true);
    expect(result.data?.pages[0]?.path).toBe('index.html');
  });
});
