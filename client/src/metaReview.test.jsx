/**
 * The Meta App Review Test screen.
 *
 * Rendered with react-dom/server rather than a DOM: vitest.config.js keeps the
 * node environment on purpose (no jsdom on Render's build for one screen), and
 * every view here is a pure function of its props, so static markup is enough
 * to prove what each state shows. The submit logic is exported separately and
 * driven directly.
 */

import { test, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SendForm, SendResult, TemplateList, submitSend } from './MetaReviewTest.jsx';
import { sendTestMessage } from './metaReview.js';

const noop = () => {};

function renderForm(state, overrides = {}) {
  return renderToStaticMarkup(
    <SendForm
      to="+2348031234567"
      message="Hello from RxNaija"
      kind="text"
      templateName="hello_world"
      language="en_US"
      state={state}
      onTo={noop}
      onMessage={noop}
      onKind={noop}
      onTemplateName={noop}
      onLanguage={noop}
      onSubmit={noop}
      {...overrides}
    />,
  );
}

test('the form renders a number field, a message field and the send button', () => {
  const html = renderForm({ status: 'idle' });
  expect(html).toContain('WhatsApp number');
  expect(html).toContain('placeholder="+234XXXXXXXXXX"');
  expect(html).toContain('Message');
  expect(html).toContain('Hello from RxNaija');
  expect(html).toMatch(/<button type="submit"[^>]*>Send WhatsApp Message<\/button>/);
});

test('choosing "template" swaps the message box for the template fields', () => {
  const text = renderForm({ status: 'idle' }, { kind: 'text' });
  expect(text).toContain('Hello from RxNaija');
  expect(text).not.toContain('Template name');

  const template = renderForm({ status: 'idle' }, { kind: 'template' });
  expect(template).toContain('Template name');
  expect(template).toContain('hello_world');
  expect(template).toContain('Template language');
  // The recipient field belongs to both.
  expect(template).toContain('WhatsApp number');
});

test('both message types are offered, with the 24-hour caveat stated on the text one', () => {
  const html = renderForm({ status: 'idle' });
  expect(html).toContain('Text message');
  expect(html).toContain('Approved template');
  expect(html).toContain('24 hours');
});

test('a template send posts kind, template name and language; a text send posts the message', async () => {
  const sent = [];
  const capture = async (payload) => { sent.push(payload); return { ok: true, messageId: 'wamid.Z' }; };

  await submitSend({ to: '+2348031234567', kind: 'template', templateName: 'hello_world', language: 'en_US' }, noop, capture);
  await submitSend({ to: '+2348031234567', message: 'Hello from RxNaija' }, noop, capture);

  expect(sent[0]).toEqual({ to: '+2348031234567', kind: 'template', templateName: 'hello_world', language: 'en_US' });
  expect(sent[1]).toEqual({ to: '+2348031234567', message: 'Hello from RxNaija' });
});

test('while sending, the button is disabled and says so', () => {
  const html = renderForm({ status: 'sending' });
  expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Sending\.\.\.<\/button>/);
});

test('success shows the confirmation and the message ID', () => {
  const html = renderToStaticMarkup(<SendResult state={{ status: 'success', messageId: 'wamid.ABC123' }} />);
  expect(html).toContain('Message sent successfully');
  expect(html).toContain('Message ID: wamid.ABC123');
});

test('failure shows the safe error', () => {
  const html = renderToStaticMarkup(<SendResult state={{ status: 'error', error: 'This number is not on your test number\'s allowed list.' }} />);
  expect(html).toContain('Message failed');
  expect(html).toContain('allowed list');
});

test('submitting moves idle → sending → success', async () => {
  const states = [];
  await submitSend(
    { to: '+2348031234567', message: 'Hello from RxNaija' },
    (s) => states.push(s),
    async (payload) => {
      expect(payload).toEqual({ to: '+2348031234567', message: 'Hello from RxNaija' });
      return { ok: true, success: true, messageId: 'wamid.X' };
    },
  );
  expect(states).toEqual([{ status: 'sending' }, { status: 'success', messageId: 'wamid.X' }]);
});

test('submitting moves idle → sending → error when the server refuses', async () => {
  const states = [];
  await submitSend({ to: 'x', message: 'y' }, (s) => states.push(s), async () => ({ ok: false, error: 'Nope' }));
  expect(states).toEqual([{ status: 'sending' }, { status: 'error', error: 'Nope' }]);
});

test('the send call goes to our own server, never to Meta, and carries no credential', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ success: true, messageId: 'wamid.Y' }) };
  };
  const res = await sendTestMessage({ to: '+2348031234567', message: 'hi' }, fakeFetch);
  expect(res).toEqual({ ok: true, success: true, messageId: 'wamid.Y' });
  expect(calls[0].url).toBe('/api/whatsapp/cloud/test-send');
  expect(calls[0].url).not.toContain('graph.facebook.com');
  expect(JSON.stringify(calls[0].init)).not.toMatch(/Bearer|access_token/);
});

test('a server error body becomes { ok: false, error } with the server\'s safe message', async () => {
  const fakeFetch = async () => ({ ok: false, status: 400, json: async () => ({ success: false, error: 'Enter a message to send.' }) });
  expect(await sendTestMessage({ to: '1', message: '' }, fakeFetch)).toEqual({ ok: false, error: 'Enter a message to send.' });
});

test('the template list shows each template with its review status', () => {
  const html = renderToStaticMarkup(
    <TemplateList templates={[{ id: '1', name: 'rxnaija_test', status: 'PENDING', category: 'UTILITY', language: 'en' }]} />,
  );
  expect(html).toContain('rxnaija_test');
  expect(html).toContain('PENDING');
  expect(html).toContain('UTILITY · en');
});
