/**
 * App shell.
 *
 * Two areas, not one list. Setup is done once; Inbox and Orders are what
 * someone behind a counter opens every day — so they are tabs rather than
 * steps, and the tab carrying work to do says how much.
 */

import { useEffect, useState } from 'react';
import ConnectWhatsApp from './ConnectWhatsApp.jsx';
import UploadCatalogue from './UploadCatalogue.jsx';
import Inbox from './Inbox.jsx';
import Orders from './Orders.jsx';

const TABS = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'orders', label: 'Orders' },
  { id: 'setup', label: 'Setup' },
];

export default function App() {
  const [tab, setTab] = useState('inbox');
  const [health, setHealth] = useState(null);
  // Badge counts live in the shell so a staff member on the Orders tab still
  // sees that someone is waiting in the Inbox. A count only visible from
  // inside the tab it describes is useless.
  const [badges, setBadges] = useState({ inbox: 0, orders: 0 });

  useEffect(() => {
    fetch('/api/health').then((r) => r.json()).then(setHealth).catch(() => setHealth({ status: 'unreachable' }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const [c, o] = await Promise.all([
          fetch('/api/conversations').then((r) => r.json()),
          fetch('/api/orders').then((r) => r.json()),
        ]);
        if (!cancelled) {
          setBadges({ inbox: c?.counts?.open_handoffs || 0, orders: o?.counts?.pending || 0 });
        }
      } catch { /* the tabs still work without badges */ }
    };
    poll();
    const t = setInterval(poll, 10000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">WhatsApp AI Automation</h1>
          <p className="mt-1 text-sm text-slate-600">
            WhatsApp customer service and sales for independent pharmacies.
          </p>
        </div>
        <span
          className={`rounded px-2 py-0.5 text-xs ${
            health?.status === 'ok' ? 'bg-teal-100 text-teal-800' : 'bg-red-100 text-red-700'
          }`}
        >
          {health ? health.status : 'checking…'}
        </span>
      </header>

      <nav className="mt-8 flex gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`-mb-px flex items-center gap-2 border-b-2 px-4 py-2 text-sm transition
              ${tab === t.id
                ? 'border-slate-900 font-medium text-slate-900'
                : 'border-transparent text-slate-500 hover:text-slate-800'}`}
          >
            {t.label}
            {badges[t.id] > 0 && (
              <span className={`rounded-full px-1.5 text-[11px] font-medium ${
                t.id === 'inbox' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-800'
              }`}>
                {badges[t.id]}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="mt-6">
        {tab === 'inbox' && <Inbox />}
        {tab === 'orders' && <Orders />}
        {tab === 'setup' && (
          <div className="space-y-4">
            <ConnectWhatsApp />
            <UploadCatalogue />
            <section className="rounded-lg border border-slate-200 p-5">
              <h2 className="font-medium">API status</h2>
              <pre className="mt-2 overflow-x-auto text-xs text-slate-600">
                {health ? JSON.stringify(health, null, 2) : 'Checking…'}
              </pre>
            </section>
          </div>
        )}
      </div>
    </main>
  );
}
