/**
 * Meta App Review Test — Settings → WhatsApp.
 *
 * AN INTERNAL TEST SCREEN, AND IT SAYS SO. It exists to record the two Meta
 * App Review videos: sending a WhatsApp message through the Cloud API
 * (whatsapp_business_messaging) and creating a message template
 * (whatsapp_business_management). It is not how pharmacies connect WhatsApp —
 * that is the Pairing tab beside it, which this does not touch.
 *
 * Every action here is a real Graph API call made by our server with
 * RxNaija's own token. Nothing on this screen is simulated.
 *
 * The result views are pure functions of state and exported, so they can be
 * rendered and checked without a browser.
 */

import { useEffect, useState } from 'react';
import * as api from './metaReview.js';

const inputClass =
  'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 '
  + 'focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600';

const primaryButton =
  'rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white transition '
  + 'hover:bg-teal-800 disabled:opacity-50';

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

/** idle | sending | success | error — the send panel's whole state. */
export function SendResult({ state }) {
  if (state.status === 'sending') {
    return <p role="status" className="text-sm text-slate-600">Sending...</p>;
  }
  if (state.status === 'success') {
    return (
      <div role="status" className="rounded-lg bg-teal-50 px-4 py-3 text-sm text-teal-900">
        <p className="font-semibold">Message sent successfully</p>
        <p className="mt-1 break-all font-mono text-xs">Message ID: {state.messageId}</p>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
        <p className="font-semibold">Message failed</p>
        <p className="mt-1">{state.error}</p>
      </div>
    );
  }
  return null;
}

export function SendForm({ to, message, state, onTo, onMessage, onSubmit }) {
  const sending = state.status === 'sending';
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
    >
      <Field label="WhatsApp number">
        <input
          className={inputClass}
          value={to}
          onChange={(e) => onTo(e.target.value)}
          placeholder="+234XXXXXXXXXX"
          inputMode="tel"
          autoComplete="off"
        />
      </Field>
      <Field label="Message">
        <textarea
          className={`${inputClass} min-h-[5rem]`}
          value={message}
          onChange={(e) => onMessage(e.target.value)}
        />
      </Field>
      <div>
        <button type="submit" className={primaryButton} disabled={sending}>
          {sending ? 'Sending...' : 'Send WhatsApp Message'}
        </button>
      </div>
      <SendResult state={state} />
    </form>
  );
}

/**
 * Submit handler, separated from the component so the transition
 * idle → sending → success | error can be tested without a DOM.
 */
export async function submitSend({ to, message }, setState, send = api.sendTestMessage) {
  setState({ status: 'sending' });
  const result = await send({ to, message });
  setState(result.ok
    ? { status: 'success', messageId: result.messageId }
    : { status: 'error', error: result.error });
}

function TemplateStatus({ status }) {
  const tone = {
    APPROVED: 'bg-teal-50 text-teal-800',
    PENDING: 'bg-amber-50 text-amber-800',
    REJECTED: 'bg-red-50 text-red-700',
  }[status] || 'bg-slate-100 text-slate-600';
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}>{status || 'UNKNOWN'}</span>;
}

export function TemplateList({ templates }) {
  if (!templates.length) return <p className="text-sm text-slate-500">No templates on this account yet.</p>;
  return (
    <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
      {templates.map((t) => (
        <li key={t.id || `${t.name}-${t.language}`} className="flex items-center justify-between gap-3 px-4 py-2.5">
          <span className="min-w-0">
            <span className="block truncate font-mono text-sm text-slate-900">{t.name}</span>
            <span className="text-xs text-slate-500">{t.category} · {t.language}</span>
          </span>
          <TemplateStatus status={t.status} />
        </li>
      ))}
    </ul>
  );
}

function TemplatesPanel() {
  const [form, setForm] = useState({
    name: 'rxnaija_test', category: 'UTILITY', language: 'en', body: 'Your order is ready for collection.',
  });
  const [state, setState] = useState({ status: 'idle' });
  const [list, setList] = useState({ status: 'loading', templates: [] });

  const refresh = async () => {
    const res = await api.listTemplates();
    setList(res.ok ? { status: 'ready', templates: res.templates } : { status: 'error', error: res.error, templates: [] });
  };

  useEffect(() => { refresh(); }, []);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const create = async () => {
    setState({ status: 'sending' });
    const res = await api.createTemplate(form);
    if (res.ok) {
      setState({ status: 'success', template: res.template });
      refresh();
    } else {
      setState({ status: 'error', error: res.error });
    }
  };

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <h3 className="font-display text-base font-semibold text-slate-900">Message templates</h3>

      <form className="mt-4 grid gap-4 md:grid-cols-2" onSubmit={(e) => { e.preventDefault(); create(); }}>
        <Field label="Template name">
          <input className={inputClass} value={form.name} onChange={set('name')} autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Category">
          <select className={inputClass} value={form.category} onChange={set('category')}>
            <option value="UTILITY">UTILITY</option>
            <option value="MARKETING">MARKETING</option>
          </select>
        </Field>
        <Field label="Language">
          <select className={inputClass} value={form.language} onChange={set('language')}>
            <option value="en">English</option>
            <option value="en_US">English (US)</option>
            <option value="en_GB">English (UK)</option>
          </select>
        </Field>
        <div className="md:col-span-2">
          <Field label="Message body">
            <textarea className={`${inputClass} min-h-[5rem]`} value={form.body} onChange={set('body')} />
          </Field>
        </div>
        <div className="md:col-span-2">
          <button type="submit" className={primaryButton} disabled={state.status === 'sending'}>
            {state.status === 'sending' ? 'Creating...' : 'Create Template'}
          </button>
        </div>
      </form>

      {state.status === 'success' && (
        <div role="status" className="mt-4 rounded-lg bg-teal-50 px-4 py-3 text-sm text-teal-900">
          <p className="font-semibold">Template submitted to Meta</p>
          <p className="mt-1 text-xs">
            <span className="font-mono">{state.template.name}</span> · status {state.template.status}
            {state.template.id && <> · ID <span className="font-mono">{state.template.id}</span></>}
          </p>
        </div>
      )}
      {state.status === 'error' && (
        <div role="alert" className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
          <p className="font-semibold">Template failed</p>
          <p className="mt-1">{state.error}</p>
        </div>
      )}

      <div className="mt-6">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-medium text-slate-700">Templates on this WhatsApp Business Account</p>
          <button type="button" onClick={refresh} className="text-sm font-medium text-teal-700 hover:underline">
            Refresh
          </button>
        </div>
        {list.status === 'loading' && <p className="text-sm text-slate-500">Loading...</p>}
        {list.status === 'error' && <p className="text-sm text-red-700">{list.error}</p>}
        {list.status === 'ready' && <TemplateList templates={list.templates} />}
      </div>
    </section>
  );
}

export default function MetaReviewTest() {
  const [status, setStatus] = useState(null);
  const [to, setTo] = useState('');
  const [message, setMessage] = useState('Hello from RxNaija');
  const [state, setState] = useState({ status: 'idle' });

  useEffect(() => {
    api.getStatus().then(setStatus);
  }, []);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="font-display text-lg font-semibold text-slate-900">Meta App Review Test</h2>
        <p className="mt-1 text-sm text-slate-600">
          Sends through the Meta WhatsApp Cloud API{status?.graphVersion ? ` (Graph ${status.graphVersion})` : ''}.
          For App Review only — this does not change how your pharmacy is connected.
        </p>
      </div>

      {status && status.ok === false && (
        <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">{status.error}</p>
      )}
      {status?.ok && !status.messaging && (
        <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Not configured on the server yet — set META_SYSTEM_USER_TOKEN and META_PHONE_NUMBER_ID.
        </p>
      )}

      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <h3 className="mb-4 font-display text-base font-semibold text-slate-900">Send a WhatsApp message</h3>
        <SendForm
          to={to}
          message={message}
          state={state}
          onTo={setTo}
          onMessage={setMessage}
          onSubmit={() => submitSend({ to, message }, setState)}
        />
      </section>

      <TemplatesPanel />
    </div>
  );
}
