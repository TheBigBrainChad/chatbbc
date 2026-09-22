import { expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { artifactSrcdoc, sanitizeStaticArtifact, STATIC_ARTIFACT_LIMITS } from '../src/shared/static-artifact.js';
import { mountStaticArtifact } from '../src/renderer/static-artifact.js';

const document = new JSDOM('<!doctype html><html><body></body></html>').window.document;
const clean = (html: string, media: { id: string; dataUrl: string }[] = []) =>
  sanitizeStaticArtifact(document, { html, media });

it.each([
  '<script>alert(1)</script>',
  '<img src=https://remote/x>',
  '<form action=/x><button>go</button></form>',
  '<div onclick=steal()>x</div>',
  '<style>@import url(https://remote/x)</style>',
  '<a href=https://remote>x</a>'
])('makes static artifact content inert: %s', html => {
  const safe = clean(html);
  expect(safe.html).not.toMatch(/script|onclick|https:|<form|@import|href=/i);
  expect(safe.rejected).not.toBeNull();
});

it('keeps a static paragraph and drops nothing from its text', () => {
  const safe = clean('<p style="color: red">Hello</p>');
  expect(safe.rejected).toBeNull();
  expect(safe.html).toContain('Hello');
  expect(safe.html).toContain('color: red');
  expect(safe.html).not.toContain('<script');
});

it('shows an external URL as text and still rejects it as an address', () => {
  const prose = clean('<p>see https://example.test</p>');
  expect(prose.rejected).toBeNull();
  expect(prose.html).toContain('https://example.test');
  expect(clean('<p><a href="https://example.test">x</a></p>').rejected).not.toBeNull();
});

it('admits one local image and rejects a fifth or a remote source', () => {
  const dataUrl = 'data:image/png;base64,aaaa';
  const safe = clean('<img data-media-id="shot" alt="cat">', [{ id: 'shot', dataUrl }]);
  expect(safe.rejected).toBeNull();
  expect(safe.html).toContain(dataUrl);
  expect(safe.html).toContain('alt="cat"');
  expect(clean('<img data-media-id="shot" alt="cat">', [{ id: 'shot', dataUrl }, { id: 'shot', dataUrl }]).rejected).toBe('media');
  const many = Array.from({ length: 5 }, (_, index) => ({ id: `m${index}`, dataUrl }));
  expect(clean('<p>x</p>', many).rejected).toBe('images');
});

it('rejects the published static limits', () => {
  expect(STATIC_ARTIFACT_LIMITS).toEqual({
    bytes: 131_072, nodes: 1024, depth: 24, text: 65_536, css: 65_536, images: 4, deadlineMs: 2_000
  });
  expect(clean(`<p>${'x'.repeat(131_073)}</p>`).rejected).toBe('bytes');
  expect(clean(`<p>${'x'.repeat(65_537)}</p>`).rejected).not.toBeNull();
  expect(clean(`<div>${'<div></div>'.repeat(1025)}</div>`).rejected).not.toBeNull();
  expect(clean(`${'<div>'.repeat(25)}x${'</div>'.repeat(25)}`).rejected).not.toBeNull();
  expect(clean(`<p style="${'color: red; '.repeat(6000)}">x</p>`).rejected).not.toBeNull();
  expect(clean('<svg><rect /></svg>').rejected).not.toBeNull();
  expect(sanitizeStaticArtifact(document, { html: '<p>Hi</p>' }, Date.now() - 3_000).rejected).toBe('deadline');
});

it('builds a scriptless srcdoc', () => {
  const srcdoc = artifactSrcdoc({ html: '<p>Hi</p>' });
  expect(srcdoc).toContain("default-src 'none'");
  expect(srcdoc).toContain("img-src data:");
  expect(srcdoc).toContain('<p>Hi</p>');
  expect(srcdoc).not.toMatch(/allow-scripts|allow-same-origin/i);
});

it('mounts a sandboxed iframe and replaces a rejected artifact with text', () => {
  const host = document.createElement('div');
  document.body.append(host);
  mountStaticArtifact(host, { html: '<p>Hi</p>' });
  const frame = host.querySelector('iframe');
  expect(frame).not.toBeNull();
  expect(frame!.getAttribute('sandbox')).toBe('');
  expect(frame!.getAttribute('referrerpolicy')).toBe('no-referrer');
  expect(frame!.srcdoc).toContain("default-src 'none'");
  expect(frame!.srcdoc).not.toMatch(/allow-scripts|allow-forms|allow-popups|allow-same-origin/i);
  mountStaticArtifact(host, { html: '<script>alert(1)</script>' });
  expect(host.querySelector('iframe')).toBeNull();
  expect(host.textContent).toContain('Open original in ChatGPT');
});

it('rejects malformed fragments and CSS image functions, and keeps URL prose', () => {
  expect(clean('<div><p></div></p>').rejected).toBe('malformed');
  expect(clean('<p>Hi</div>').rejected).toBe('malformed');
  expect(clean('<div').rejected).toBe('malformed');
  expect(clean('<p style="background: image-set(url(http://remote/x) 1x)">x</p>').rejected).not.toBeNull();
  expect(clean('<p style="background: -webkit-image-set(url(http://remote/x) 1x)">x</p>').rejected).not.toBeNull();
  expect(clean('<p style="color: \\72 ed">x</p>').rejected).not.toBeNull();
  expect(clean('<p><div>x</div></p>').rejected).toBe('malformed');
  expect(clean('<div/>').rejected).toBe('malformed');
  expect(clean('<p style="background:u/**/rl(data:,x)">x</p>').rejected).not.toBeNull();
  expect(clean('<p style="background:u/**/rl(data:,x)">x</p>').html).not.toMatch(/url|data:/i);
  const prose = clean('<p>see https://example.test</p>');
  expect(prose.rejected).toBeNull();
  expect(prose.html).toContain('https://example.test');
  const nested = (depth: number) => `${'<div>'.repeat(depth)}x${'</div>'.repeat(depth)}`;
  expect(clean(nested(24)).rejected).toBeNull();
  expect(clean(nested(25)).rejected).not.toBeNull();
});
