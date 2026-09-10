/**
 * The Website section's own navigation.
 *
 * FOUR TABS, BECAUSE THE PAGE WAS ANSWERING FOUR DIFFERENT QUESTIONS.
 * Overview is "is it working" — the thing itself and what it did. Content is
 * "what does it say". Design is "what does it look like". Settings is the
 * address and the publish state. An owner arriving with one of those in mind
 * now lands on it instead of scrolling past the other three.
 *
 * THE HEADER STAYS ABOVE THIS, ALWAYS. Whether the site is live, and the
 * button that publishes it, are not one tab's business — they are the state
 * of the whole section, and burying either behind a tab would reintroduce
 * exactly the fault this restructure set out to remove.
 *
 * A SEGMENTED CONTROL, NOT UNDERLINED TABS. Four short words in a row read as
 * a switch; underlines at this width read as an afterthought stuck to the top
 * of a card. The moving background is the only decoration and it is the one
 * that carries meaning.
 *
 * STATE LIVES IN THE PARENT and is not persisted. A remembered tab is a
 * remembered assumption about why someone came back, and the honest default —
 * "show me the website" — is right far more often than any guess.
 */

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'content', label: 'Content' },
  { id: 'design', label: 'Design' },
  { id: 'settings', label: 'Settings' },
];

export default function WebsiteTabs({ active, onChange }) {
  return (
    <div
      role="tablist"
      aria-label="Website sections"
      className="inline-flex w-full gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1 sm:w-auto"
    >
      {TABS.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(tab.id)}
            className={`flex-1 rounded-lg px-4 py-2 text-sm font-semibold transition sm:flex-none ${
              selected
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

export { TABS };
