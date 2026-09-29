import { expect, it } from 'vitest';
import {
  hasContentReference,
  hasProviderDirective,
  modelFacingText,
  plainTextOfHtml,
  resolvedCapture,
  withoutProviderDirectives
} from '../src/shared/content-reference.js';

const pointer = '::chatgpt-content-reference{index="0" source_message_id="m-source"}';

it('uses a resolved same-message capture and never returns raw directives', () => {
  expect(hasContentReference(pointer)).toBe(true);
  expect(modelFacingText(pointer, { text: '<p>Resolved <strong>answer</strong></p>', truncated: false })).toBe('Resolved answer');
  expect(modelFacingText(pointer)).not.toContain('::chatgpt-content-reference');
  expect(modelFacingText(`Intro\n${pointer}\nOutro`)).toBe('Intro\n\nOutro');
});

it('handles unknown provider directives without treating writing blocks as unknown', () => {
  const leaf = 'Before\n::chatgpt-entity{id="42"}\nAfter';
  expect(hasProviderDirective(leaf)).toBe(true);
  expect(withoutProviderDirectives(leaf)).toBe('Before\n\nAfter');
  expect(modelFacingText(leaf, { text: '<p>Before</p><p>Berlin</p><p>After</p>' })).toBe('Before\nBerlin\nAfter');

  const container = ':::canvas{title="Plan"}\nStep one\nStep two\n:::';
  expect(hasProviderDirective(container)).toBe(true);
  expect(modelFacingText(container)).toBe('Step one\nStep two');

  expect(hasProviderDirective(':::writing{title="x"}\nText\n:::')).toBe(false);
  expect(hasProviderDirective('Great :smile: work')).toBe(false);
  expect(hasProviderDirective('Note: the ratio is 3::1 here')).toBe(false);
});

it('rejects unresolved or truncated captures and decodes plain text safely', () => {
  expect(resolvedCapture({ text: `<p>${pointer}</p>`, truncated: false })).toBe(false);
  expect(resolvedCapture({ text: '<p>cut</p>', truncated: true })).toBe(false);
  expect(modelFacingText(pointer, { text: '<p>cut</p>', truncated: true })).not.toContain('cut');
  expect(plainTextOfHtml('<p>a&#39;b &#x41; &nbsp;c</p><script>x()</script>')).toBe("a'b A  c");
});
