/**
 * What the customer is told when their order moves.
 *
 * EXTRACTED SO THERE IS EXACTLY ONE VERSION OF THESE SENTENCES.
 * An order can now be actioned from two places — the dashboard
 * (routes/orders.js) and the pharmacy's own WhatsApp (worker.js's staff
 * command path). Two copies of this text would drift, and the drift would be
 * invisible: both surfaces would look right in isolation while telling the
 * same customer different things about the same order depending on which
 * button the pharmacist happened to reach for.
 *
 * Written out rather than generated, because these are the sentences a
 * pharmacy is accountable for.
 */

const naira = (kobo) => (kobo === null || kobo === undefined ? null : kobo / 100);
const money = (kobo) => `₦${Number(naira(kobo)).toLocaleString('en-NG')}`;

/**
 * @param {object} order  must carry `reference`, `total_kobo`, `stock_held`
 * @param {string} toStatus
 * @returns {string|null} null when the transition is not one the customer
 *   should hear about at all.
 */
function customerMessage(order, toStatus) {
  const ref = order.reference;
  switch (toStatus) {
    case 'confirmed':
      // The ONLY place the word "reserved" is used to a customer, and it is
      // true here: this transition is what commits the stock (see
      // orderService.commitStock) — a pharmacist has agreed to supply it and
      // the pack is now actually off the shelf. Saying it any earlier would
      // promise something no human had approved, which is why the assistant
      // is blocked from saying it at all.
      return order.stock_held
        ? `Your order ${ref} is confirmed and reserved for you. Total ${money(order.total_kobo)}. We'll let you know when it's ready to collect.`
        : `Your order ${ref} has been confirmed by the pharmacy. Total ${money(order.total_kobo)}. We'll let you know when it's ready.`;
    case 'ready':
      return `Your order ${ref} is ready for collection. Total ${money(order.total_kobo)}.`;
    case 'completed':
      return `Thank you — order ${ref} is complete. We hope to see you again.`;
    case 'rejected':
      return `We're sorry — the pharmacy can't fulfil order ${ref} right now. Please call or come in and we'll help.`;
    case 'cancelled':
      return `Order ${ref} has been cancelled. If that wasn't expected, please get in touch.`;
    default:
      return null;
  }
}

module.exports = { customerMessage, money, naira };
