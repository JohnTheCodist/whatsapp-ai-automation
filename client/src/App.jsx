/**
 * Scaffold shell.
 *
 * Renders the three onboarding steps as the app's spine, because that flow
 * IS the product's first-run experience and everything else in the
 * dashboard hangs off having completed it. Steps are placeholders until
 * their phase lands — see ARCHITECTURE.md.
 */

import { useEffect, useState } from 'react';

const STEPS = [
  {
    id: 'whatsapp',
    title: 'Connect WhatsApp',
    body: 'Link the pharmacy WhatsApp number. No Twilio or Meta console required.',
    phase: 'Phase 2',
  },
  {
    id: 'catalogue',
    title: 'Upload catalogue',
    body: 'Drop in the stock spreadsheet. Columns are detected automatically; anything unclear is asked once.',
    phase: 'Phase 3',
  },
  {
    id: 'golive',
    title: 'Go live',
    body: 'Send a test message, confirm the reply, and switch the assistant on.',
    phase: 'Phase 4',
  },
];

export default function App() {
  const [health, setHealth] = useState(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth({ status: 'unreachable' }));
  }, []);

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">WhatsApp AI Automation</h1>
      <p className="mt-2 text-slate-600">
        WhatsApp customer service and sales for independent pharmacies.
      </p>

      <ol className="mt-10 space-y-4">
        {STEPS.map((step, i) => (
          <li key={step.id} className="rounded-lg border border-slate-200 p-5">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="font-medium">
                <span className="mr-2 text-slate-400 tabular-nums">{i + 1}</span>
                {step.title}
              </h2>
              <span className="shrink-0 rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                {step.phase}
              </span>
            </div>
            <p className="mt-1 text-sm text-slate-600">{step.body}</p>
          </li>
        ))}
      </ol>

      <section className="mt-10 rounded-lg border border-slate-200 p-5">
        <h2 className="font-medium">API status</h2>
        <pre className="mt-2 overflow-x-auto text-xs text-slate-600">
          {health ? JSON.stringify(health, null, 2) : 'Checking…'}
        </pre>
      </section>
    </main>
  );
}
