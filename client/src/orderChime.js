/**
 * An audible alert when a new order arrives.
 *
 * WHY IT IS SYNTHESISED, NOT AN AUDIO FILE
 * Generated with the Web Audio API rather than shipping an mp3: no asset to
 * host, nothing fetched at runtime, and it works offline. It also keeps the
 * page free of any external request, which the rest of this app already
 * avoids deliberately.
 *
 * WHY UNLOCKING IS NECESSARY
 * Every modern browser blocks audio until the user has interacted with the
 * page. Without an explicit unlock the chime silently never plays, and a
 * pharmacist would trust an alert that does not exist — which is worse than
 * having no alert at all, because they would stop checking the screen.
 * `isUnlocked()` lets the UI say so honestly.
 */

let ctx = null;
let unlocked = false;

function context() {
  if (!ctx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    ctx = new AudioCtx();
  }
  return ctx;
}

/** Call from a real click. Browsers refuse to start audio any other way. */
export async function unlockChime() {
  const c = context();
  if (!c) return false;
  try {
    if (c.state === 'suspended') await c.resume();
    unlocked = c.state === 'running';
    return unlocked;
  } catch {
    return false;
  }
}

export function isUnlocked() {
  return unlocked && context()?.state === 'running';
}

/**
 * A more insistent alarm for someone waiting on a pharmacist.
 *
 * Distinct from the order chime on purpose: lower, slower and longer, so a
 * clinical escalation does not sound like a sale. Staff should be able to
 * tell which one it is from across the shop without looking.
 */
export function playConsultationAlarm() {
  const c = context();
  if (!c || c.state !== 'running') return false;

  const now = c.currentTime;
  for (let r = 0; r < 3; r++) {
    const base = now + r * 0.75;
    // A falling pair rather than the order chime's rising one — the shape is
    // what makes them distinguishable, more than the pitch.
    [660, 494].forEach((freq, i) => {
      const start = base + i * 0.22;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.3, start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.26);
      osc.connect(gain).connect(c.destination);
      osc.start(start);
      osc.stop(start + 0.28);
    });
  }
  return true;
}

/**
 * Two rising notes, repeated — a phone-like ring rather than a single blip.
 * A counter is a noisy place and one short tone gets missed.
 */
export function playOrderChime({ repeats = 2 } = {}) {
  const c = context();
  if (!c || c.state !== 'running') return false;

  const now = c.currentTime;
  // Deliberately short and bounded. An alert that keeps ringing until
  // acknowledged becomes something staff mute permanently, at which point it
  // protects nobody.
  for (let r = 0; r < repeats; r++) {
    const base = now + r * 0.62;
    [880, 1174.66].forEach((freq, i) => {
      const start = base + i * 0.16;
      const osc = c.createOscillator();
      const gain = c.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, start);

      // Ramped rather than switched: an abrupt gain change produces an
      // audible click on most hardware.
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.19);

      osc.connect(gain).connect(c.destination);
      osc.start(start);
      osc.stop(start + 0.2);
    });
  }
  return true;
}
