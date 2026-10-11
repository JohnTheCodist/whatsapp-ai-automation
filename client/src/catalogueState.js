/**
 * What the Catalogue screen shows when it is not showing a list of products.
 *
 * PURE — no React, no fetch. It answers one question: given what the last
 * read produced, which of four things is true?
 *
 * THE DEFECT THIS EXISTS FOR. The Catalogue rendered its product list behind
 * `products?.products?.length > 0` with no `else`, so a pharmacy with nothing
 * in its catalogue opened the screen and saw a price switch in an empty box —
 * no sentence, no next step. That is the first screen a new pharmacy opens,
 * and this product cannot do anything at all until something is in here: the
 * assistant sells from the catalogue and from nowhere else.
 *
 * THE TWO BLANK SCREENS WERE NOT THE SAME BLANK SCREEN, which is the part
 * that made this worth a module rather than a ternary. A catalogue that is
 * empty and a catalogue that could not be READ both rendered as nothing:
 *
 *   products: []        nobody has uploaded anything      -> say so, and how
 *   the read failed     we do not know what is in there   -> never say "none"
 *
 * That is the same distinction the allergy card has made since 0058 and the
 * care-programme card since its phase 3 — "No care programmes" and "Not
 * recorded" are different claims — applied to stock instead of a patient. A
 * pharmacy owner told "no products" when the request actually failed will go
 * and upload a catalogue they have already uploaded.
 *
 * LOADING IS A THIRD STATE and says nothing at all. A screen that flashes
 * "No products yet" on its way to showing four hundred of them has told the
 * reader something false, briefly, which is worse than an empty moment.
 */

/**
 * Which of the four states the Catalogue is in.
 *
 * @param {object} args
 * @param {object|null} args.products  the last successful `/products` read, or null
 * @param {boolean} args.listStale     the last read FAILED (UploadCatalogue's own flag)
 * @returns {'loading'|'failed'|'empty'|'list'}
 *
 * ORDER MATTERS. `listStale` is checked before emptiness because the flag
 * survives a failure that left `products` holding an older read — and the one
 * thing this must never do is answer "empty" about a catalogue it could not
 * see. Failing closed, the same way the test-database guard does (GOLDEN-002c):
 * "we could not tell" is never "there is nothing there".
 */
export function catalogueState({ products = null, listStale = false } = {}) {
  if (products?.products?.length > 0) return 'list';
  if (listStale) return 'failed';
  if (!products) return 'loading';
  return 'empty';
}

/**
 * What each blank state says, and the one thing it offers to do about it.
 *
 * SHORT ON PURPOSE. The Consultation redesign cut 188 words of permanent
 * on-screen prose to 20 and the screen got better, so this is two sentences
 * and a button rather than a paragraph explaining what a catalogue is.
 *
 * `action.tab` names a screen in this app rather than describing where to
 * find it. "See Upload in the sidebar" is an instruction; a button is the
 * thing itself.
 *
 * Returns null for the states that must stay silent — `loading`, and `list`,
 * which is the product list's own job.
 */
export function catalogueEmptyText(state) {
  if (state === 'empty') {
    return {
      title: 'No products yet',
      // The consequence, said once. This is not a sales line: the assistant
      // answers "do you have X?" out of this table and has nothing to say
      // until it is filled.
      body: 'The assistant can only offer what is in your catalogue.',
      action: { label: 'Upload a catalogue', tab: 'inventory-upload' },
    };
  }
  if (state === 'failed') {
    return {
      title: 'The catalogue could not be loaded',
      // NEVER "no products". The whole reason this state is separate is that
      // the screen does not know what is in the catalogue, and saying it is
      // empty would send somebody to re-upload a catalogue that is already
      // there.
      body: 'That is this page failing to read it, not the catalogue being empty.',
      action: { label: 'Try again', retry: true },
    };
  }
  return null;
}
