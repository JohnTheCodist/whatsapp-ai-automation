/**
 * How a conversation's workflow state looks, in one place.
 *
 * WHY A SHARED COMPONENT RATHER THAN A CLASS STRING PER SCREEN
 * The inbox and the customer profile both render this. If each styled it
 * locally, "waiting for pharmacist" would eventually be red on one screen and
 * amber on the other, and a pharmacist scanning between them would have to
 * re-learn the colours. The one state that means "a person is waiting on
 * clinical judgement" has to look identical everywhere it appears.
 *
 * COLOUR IS NOT THE ONLY SIGNAL
 * Every badge carries a text label, and the urgent one carries a filled dot
 * rather than an outline. Colour alone fails for a colour-blind pharmacist
 * and fails again on a bad screen in a bright shop.
 *
 * The labels are deliberately what a pharmacist would say out loud — "Needs
 * pharmacist", not WAITING_FOR_PHARMACIST. The enum belongs in the database.
 */

export const STATE_LABEL = {
  open: 'Open',
  ai_handling: 'Assistant handling',
  waiting_for_customer: 'Waiting on customer',
  waiting_for_pharmacist: 'Needs pharmacist',
  resolved: 'Resolved',
  archived: 'Archived',
};

/**
 * Semantic, not decorative. Red is reserved for the single state that can
 * actually harm someone by being ignored — if anything else used it, the
 * colour would stop carrying that meaning.
 */
const STATE_TONE = {
  open: 'bg-slate-100 text-slate-700',
  ai_handling: 'bg-teal-50 text-teal-700',
  waiting_for_customer: 'bg-amber-50 text-amber-800',
  waiting_for_pharmacist: 'bg-red-50 text-red-700',
  resolved: 'bg-slate-100 text-slate-600',
  archived: 'bg-slate-50 text-slate-400',
};

const DOT_TONE = {
  open: 'bg-slate-400',
  ai_handling: 'bg-teal-500',
  waiting_for_customer: 'bg-amber-500',
  waiting_for_pharmacist: 'bg-red-500',
  resolved: 'bg-slate-300',
  archived: 'bg-slate-300',
};

export default function ConversationState({ state, className = '' }) {
  if (!state) return null;
  const label = STATE_LABEL[state] || state;
  const tone = STATE_TONE[state] || STATE_TONE.open;
  const urgent = state === 'waiting_for_pharmacist';

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${tone} ${className}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${DOT_TONE[state] || DOT_TONE.open} ${urgent ? 'animate-pulse' : ''}`}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}
