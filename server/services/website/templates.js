/**
 * Template registry.
 *
 * A TEMPLATE IS A COMPOSITION, NOT AN IMPLEMENTATION. It is an ordered list
 * of block references — `{type, version, props}` — and nothing else. No HTML,
 * no CSS, no renderer, no copy of a block's behaviour. Changing how a hero
 * looks is a change to `blocks/definitions/actions.js`, and every template
 * that references it follows automatically.
 *
 * TEMPLATES CARRY NO PHARMACY DATA. Look at the seeds below: not one of them
 * sets an address, a phone number, opening hours or a WhatsApp number. Those
 * props declare `from` bindings in the block contract, so a site built from a
 * template inherits them from pharmacy_profile at render time and CANNOT
 * drift from it. A template that seeded them would be handing every new
 * pharmacy a stale copy of somebody's data on day one.
 *
 * The props that ARE set here are editorial: a heading, a section title. They
 * are what makes Professional read differently from Modern.
 *
 * ADDING TEMPLATE 4 THROUGH 10: one entry in TEMPLATES. No change to the
 * builder, the block registry, the renderer, the API or the schema.
 * templateIntegrity in websiteService.test.js validates every seed against
 * the block registry, so a template referencing a block that does not exist
 * — or passing it a prop it does not accept — fails the suite rather than a
 * pharmacy.
 *
 * VERSIONS ARE A PROMISE. A site stores template_id + template_version and a
 * CLONE of the seed. Bumping `version` here never touches a site somebody
 * already published; it only changes what the next pharmacy starts from.
 *
 * PHASE 2 SCOPE: Professional is complete. Modern and Premium arrive in
 * Phase 3 with the guided generator, which is when their editorial voice can
 * be written against real screens rather than guessed at.
 */

const { validateBlock } = require('./blocks');

/** Shorthand so a composition reads as a list of blocks, not a wall of JSON. */
const b = (type, version, props = {}) => ({ type, version, props });

/**
 * A template carries a THEME as well as a composition.
 *
 * Choosing "Modern" and getting the Professional palette would make the three
 * options feel like one option with the sections shuffled. The theme is what
 * most of the difference actually is — and because it is only ever a palette
 * id, a font id and a radius id from theme.js's fixed sets, a template cannot
 * introduce a look that the branding step could not also produce.
 *
 * The owner can change any of it afterwards. This is the starting point, not
 * a lock.
 */
const TEMPLATES = [
  {
    id: 'professional',
    version: 1,
    name: 'Professional',
    description: 'Clean and clinical. For pharmacies that lead with trust.',
    // A static file under client/public, not an import — the server never
    // needs to know how the dashboard bundles images.
    preview: '/website-templates/professional.webp',
    theme: { palette: 'teal', font: 'clinical', corners: 'soft' },
    seed: {
      blocks: [
        b('pharmacy.header', 1),
        b('pharmacy.hero', 1, {
          heading: 'Your neighbourhood pharmacy',
          subheading: 'Prescriptions, advice and everyday health — from people who know you.',
        }),
        b('pharmacy.about', 1, { heading: 'About us' }),
        b('pharmacy.services', 1, { heading: 'What we offer' }),
        b('pharmacy.openingHours', 1, { heading: 'Opening hours' }),
        b('pharmacy.location', 1, { heading: 'Find us' }),
        // The closing band, and the page's last word. A heading turns the
        // bare button into a real ending rather than one more section — see
        // the whatsappCta renderer.
        b('pharmacy.whatsappCta', 1, {
          heading: 'Need something from the pharmacy?',
          description: 'Message us on WhatsApp and we will tell you what we have before you travel.',
          label: 'Chat with us on WhatsApp',
          style: 'band',
        }),
        b('pharmacy.footer', 1),
      ],
    },
  },

  {
    id: 'modern',
    version: 1,
    name: 'Modern',
    description: 'Bold and direct. Puts the WhatsApp button in front of everything.',
    preview: '/website-templates/modern.webp',
    theme: { palette: 'green', font: 'bold', corners: 'round' },
    seed: {
      // The WhatsApp band sits SECOND, immediately under the hero, rather
      // than near the footer. This template is for a pharmacy whose website
      // exists to start conversations rather than to be read — so the action
      // comes before the story, and About sits below Services.
      blocks: [
        b('pharmacy.header', 1),
        b('pharmacy.hero', 1, {
          heading: 'Medicines, fast — just message us',
          subheading: 'Tell us what you need on WhatsApp. We will confirm what is in stock and have it ready.',
          primaryCtaLabel: 'Message us now',
        }),
        b('pharmacy.whatsappCta', 1, {
          label: 'Ask about a medicine',
          style: 'band',
        }),
        b('pharmacy.services', 1, { heading: 'How we can help' }),
        b('pharmacy.about', 1, { heading: 'Who we are' }),
        b('pharmacy.reviews', 1, { heading: 'What our customers say' }),
        b('pharmacy.openingHours', 1, { heading: 'When we are open' }),
        b('pharmacy.location', 1, { heading: 'Where to find us' }),
        b('pharmacy.footer', 1),
      ],
    },
  },

  {
    id: 'premium',
    version: 1,
    name: 'Premium',
    description: 'Considered and established. For pharmacies that lead with expertise.',
    preview: '/website-templates/premium.webp',
    theme: { palette: 'slate', font: 'classic', corners: 'sharp' },
    seed: {
      // Leads with the pharmacist rather than with the shop. The
      // pharmacistCta block sits high, and Contact is present in full —
      // this is the composition for a pharmacy whose customers come for
      // advice as much as for products.
      blocks: [
        b('pharmacy.header', 1),
        b('pharmacy.hero', 1, {
          heading: 'Expert pharmacy care, close to home',
          subheading: 'Qualified pharmacists you can talk to, and the medicines you need without the wait.',
          primaryCtaLabel: 'Speak to our team',
        }),
        b('pharmacy.about', 1, { heading: 'Our pharmacy' }),
        b('pharmacy.pharmacistCta', 1, {
          heading: 'Not sure what you need?',
          description: 'Our pharmacists answer questions every day. Ask us before you buy — there is no charge for advice.',
          buttonLabel: 'Ask a pharmacist',
        }),
        b('pharmacy.services', 1, { heading: 'Services' }),
        b('pharmacy.openingHours', 1, { heading: 'Opening hours' }),
        b('pharmacy.location', 1, { heading: 'Visit us' }),
        b('pharmacy.contact', 1, { heading: 'Get in touch' }),
        b('pharmacy.footer', 1),
      ],
    },
  },
];

/**
 * Manifest only — never the seed. The picker needs metadata, not payload.
 *
 * `theme` and `blocks` ARE included: the picker draws each card in the
 * template's own colours and lists what the page will contain, which is how
 * an owner tells the three apart before committing. Both are small, and
 * neither is the payload — the seed itself stays server-side and is cloned
 * on selection.
 */
function listTemplates() {
  return TEMPLATES.map(({ id, version, name, description, preview, theme, seed }) => ({
    id,
    version,
    name,
    description,
    preview,
    theme,
    blocks: seed.blocks.map((block) => block.type),
  }));
}

function getTemplate(templateId) {
  if (typeof templateId !== 'string') return null;
  return TEMPLATES.find((t) => t.id === templateId) || null;
}

/**
 * A deep, mutable copy of a template's seed.
 *
 * CLONED, NOT SHARED. Handing a site a reference to the registry's own object
 * would mean one pharmacy's edit mutating the template every other pharmacy
 * is created from — silent, and not discoverable until two sites had the same
 * hero text.
 */
function cloneSeed(templateId) {
  const template = getTemplate(templateId);
  if (!template) return null;
  return structuredClone(template.seed);
}

/**
 * Check a template's seed against the block registry.
 *
 * Exported rather than run at require time: a broken template should fail the
 * test suite loudly, not stop the server booting for every pharmacy including
 * the ones with no website.
 *
 * @returns {{ok:true} | {ok:false, error:string}}
 */
function validateTemplate(template) {
  if (!template?.seed?.blocks || !Array.isArray(template.seed.blocks)) {
    return { ok: false, error: `template ${template?.id} has no seed.blocks array` };
  }
  for (const [i, block] of template.seed.blocks.entries()) {
    const checked = validateBlock(block, `${template.id}.seed.blocks[${i}]`);
    if (!checked.ok) return { ok: false, error: checked.error };
    // A composition must pin the version it was authored against. Without
    // this, registering a v2 would silently re-point every template at it.
    if (block.version === undefined) {
      return { ok: false, error: `${template.id}.seed.blocks[${i}] must state an explicit block version` };
    }
  }
  return { ok: true };
}

module.exports = { TEMPLATES, listTemplates, getTemplate, cloneSeed, validateTemplate };
