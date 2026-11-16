import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@/test/render';
import { buildEmailFrameDocument, EMAIL_FRAME_CSP, EmailHtmlFrame } from './EmailHtmlFrame';

describe('buildEmailFrameDocument', () => {
  it('starts with the CSP meta and the base target, in that order, and the email follows', () => {
    const doc = buildEmailFrameDocument('<p>Hi</p>');
    expect(
      doc.startsWith(
        `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:"><base target="_blank">`,
      ),
    ).toBe(true);
    expect(doc.endsWith('<p>Hi</p>')).toBe(true);
  });

  it('allows nothing to load but images and fonts that arrive inside the markup, and inline styles', () => {
    expect(EMAIL_FRAME_CSP).toBe("default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:");
    // No remote scheme and no wildcard anywhere in the policy.
    expect(EMAIL_FRAME_CSP).not.toMatch(/https?:|\*/);
    expect(EMAIL_FRAME_CSP).not.toContain('script-src');
  });

  it('switches DNS prefetching off, which a policy cannot see', () => {
    expect(buildEmailFrameDocument('')).toContain('<meta http-equiv="x-dns-prefetch-control" content="off">');
  });

  it('never lets the email come before the policy, however it begins', () => {
    const hostile = '</head><meta http-equiv="refresh" content="0;url=https://evil.example"><script>1</script>';
    const doc = buildEmailFrameDocument(hostile);
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf(hostile));
  });
});

describe('EmailHtmlFrame', () => {
  it('is an iframe with an EMPTY sandbox, an srcdoc and no referrer', () => {
    render(<EmailHtmlFrame html="<p>Hi</p>" title="Email" />);
    const frame = screen.getByTitle('Email') as HTMLIFrameElement;

    expect(frame.tagName).toBe('IFRAME');
    expect(frame.hasAttribute('sandbox')).toBe(true);
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toBe(buildEmailFrameDocument('<p>Hi</p>'));
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.hasAttribute('src')).toBe(false);
  });

  it('does not put the email into this page: no element of the email exists outside the frame', () => {
    const { container } = render(<EmailHtmlFrame html='<h1 id="x">Hi</h1><script id="s">1</script>' title="Email" />);
    expect(container.querySelector('#x')).toBeNull();
    expect(container.querySelector('#s')).toBeNull();
  });
});

describe('the email components never build markup of their own', () => {
  const dir = __dirname;
  /** The code, without its comments (which are allowed to name what they forbid). */
  const code = (name: string): string =>
    readFileSync(join(dir, name), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  const sources = readdirSync(dir).filter((name) => /\.tsx?$/.test(name) && !/\.test\./.test(name));

  it.each(sources)('%s has no dangerouslySetInnerHTML and no innerHTML assignment', (name) => {
    const source = code(name);
    expect(source).not.toMatch(/dangerouslySetInnerHTML/);
    expect(source).not.toMatch(/\.(inner|outer)HTML\s*=/);
  });

  it('the one iframe of this tree carries an empty sandbox attribute', () => {
    const framed = sources.filter((name) => /<iframe/.test(code(name)));
    expect(framed).toEqual(['EmailHtmlFrame.tsx']);
    expect(code('EmailHtmlFrame.tsx')).toMatch(/sandbox=""/);
  });
});
