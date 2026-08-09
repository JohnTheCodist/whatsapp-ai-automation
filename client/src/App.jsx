/**
 * App shell.
 *
 * The three onboarding steps are the product's spine — everything else in
 * the dashboard depends on having completed them. Step 1 is live as of
 * Phase 2; the rest are placeholders until their phase lands.
 */

import { useEffect, useState } from 'react';
import ConnectWhatsApp from './ConnectWhatsApp.jsx';
import UploadCatalogue from './UploadCatalogue.jsx';

const PENDING_STEPS = [
  {
    id: 'golive',
    n: 3,
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

      <div className="mt-10 space-y-4">
        <ConnectWhatsApp />
        <UploadCatalogue />
      </div>

      <ol className="mt-4 space-y-4">
        {PENDING_STEPS.map((step) => (
          <li key={step.id} className="rounded-lg border border-slate-200 p-5 opacity-60">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="font-medium">
                <span className="mr-2 text-slate-400 tabular-nums">{step.n}</span>
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
