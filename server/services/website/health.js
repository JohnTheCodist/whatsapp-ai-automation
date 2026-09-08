/**
 * The health article library.
 *
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 * A small, fixed set of articles written once for the platform, which a
 * pharmacy may choose to publish. It is NOT per-pharmacy generation. A model
 * writing health copy for each pharmacy would put unreviewed medical text on
 * a real, NAFDAC-registered business's website under its name — and this
 * product's assistant refuses to answer clinical questions in WhatsApp for
 * exactly that reason. Doing on a website what we refuse to do in a chat, in
 * a more permanent medium that Google indexes, would be incoherent.
 *
 * RELEVANCE OVER QUANTITY. Four articles that a pharmacy customer in Nigeria
 * actually benefits from beats fifty generic ones. The structure below
 * supports growing to ten or thirty; nothing about it rewards adding a
 * thirty-first that nobody needed.
 *
 * NOTHING HERE DIAGNOSES, DOSES OR PROMISES.
 * Every article was written to these rules and they are not stylistic:
 *   - no dosages, no drug names as recommendations, no treatment plans
 *   - no numeric thresholds presented as a verdict on a reader's own result
 *   - no "this means you have X"
 *   - every article ends by naming the circumstances in which a person should
 *     stop reading and see someone
 * A website cannot examine anybody. The most useful thing it can honestly do
 * is explain what something is and be clear about when to get help.
 *
 * THE REVIEWER CANNOT BE FABRICATED, and this is enforced rather than
 * requested. An article is publishable only when status is APPROVED, and
 * approval requires a named reviewer with a real date. The four articles here
 * ship as PENDING_REVIEW with reviewer null, because no pharmacist has read
 * them yet — so out of the box a pharmacy can publish none of them. That is
 * the correct default, not an oversight: "Medically reviewed by" is a claim
 * about a person, and software must not be able to make it on its own.
 */

/**
 * Publication status.
 *
 * DRAFT          being written; not offered to anyone
 * PENDING_REVIEW written, awaiting a pharmacist
 * APPROVED       a named pharmacist has reviewed it; publishable
 * ARCHIVED       withdrawn; kept so existing links can be handled deliberately
 */
const STATUS = {
  DRAFT: 'draft',
  PENDING_REVIEW: 'pending_review',
  APPROVED: 'approved',
  ARCHIVED: 'archived',
};

/** The shared closing line. Present on every article, by construction. */
const GENERAL_DISCLAIMER =
  'This page is general information, not medical advice. It cannot take account of your '
  + 'own health, your other medicines or your circumstances. Speak to a pharmacist or '
  + 'doctor about anything that concerns you.';

const ARTICLES = [
  {
    slug: 'hypertension',
    title: 'High blood pressure: what it is and why checks matter',
    summary: 'High blood pressure usually causes no symptoms, which is why having it measured matters.',
    status: STATUS.PENDING_REVIEW,
    author: null,
    reviewer: null,
    reviewedAt: null,
    updatedAt: '2026-09-08',
    relatedServices: ['blood-pressure-check', 'medication-counselling'],
    relatedArticles: ['diabetes', 'medicine-safety'],
    intro:
      'Blood pressure is the force of blood pushing against the walls of your arteries. '
      + 'When it stays higher than it should be over a long period, it makes the heart work '
      + 'harder and can damage blood vessels over time.',
    sections: [
      {
        heading: 'Why it is often missed',
        paragraphs: [
          'High blood pressure usually has no symptoms at all. Someone can have it for years '
          + 'and feel completely well, which is why it is sometimes described as a silent '
          + 'condition.',
          'Because there is nothing to feel, the only way to know is to have it measured. '
          + 'That is the whole reason a check is worth having even when nothing seems wrong.',
        ],
      },
      {
        heading: 'What a check involves',
        paragraphs: [
          'A cuff is placed around your upper arm and inflated briefly while you sit still. '
          + 'It takes a few minutes and is not painful.',
          'You may be asked to sit quietly beforehand, and to avoid hurrying in, because '
          + 'rushing can affect the reading. One high reading on one day does not by itself '
          + 'mean very much — what matters is the pattern over time, which is why repeat '
          + 'checks are more useful than a single one.',
        ],
      },
      {
        heading: 'What affects blood pressure',
        paragraphs: [
          'Several things are known to play a part, including body weight, how much salt is '
          + 'in the diet, physical activity, alcohol, smoking, stress, and family history. '
          + 'Some medicines and other health conditions also affect it.',
          'Which of these matter for any particular person, and what to do about them, is a '
          + 'conversation to have with a health professional who knows your situation.',
        ],
      },
      {
        heading: 'If you have been prescribed medicine for it',
        paragraphs: [
          'Blood pressure medicines are usually taken every day, often for a long time, and '
          + 'they work by keeping the pressure down rather than by curing anything. Feeling '
          + 'well is not a sign that they are no longer needed.',
          'If something about your medicine is difficult — the timing, the cost, side effects, '
          + 'or simply remembering it — a pharmacist would rather hear about it than have you '
          + 'stop. There are often options.',
        ],
      },
    ],
    seekCare: {
      heading: 'When to seek care straight away',
      intro: 'Some symptoms need urgent attention rather than a pharmacy visit. Go to a hospital or call for help if you or someone else has:',
      items: [
        'chest pain, or pain spreading to the arm, neck or jaw',
        'sudden weakness or numbness in the face, arm or leg, especially on one side',
        'sudden difficulty speaking or understanding speech',
        'sudden severe headache unlike any before, or sudden loss of vision',
        'severe shortness of breath',
      ],
      closing: 'These are emergencies. Do not wait to see whether they settle.',
    },
  },

  {
    slug: 'diabetes',
    title: 'Diabetes: understanding blood sugar and monitoring',
    summary: 'What diabetes is, what monitoring involves, and the signs that mean you should be seen.',
    status: STATUS.PENDING_REVIEW,
    author: null,
    reviewer: null,
    reviewedAt: null,
    updatedAt: '2026-09-08',
    relatedServices: ['blood-glucose-testing', 'medication-counselling'],
    relatedArticles: ['hypertension', 'medicine-safety'],
    intro:
      'Diabetes is a condition where the level of sugar in the blood is higher than it '
      + 'should be, because the body either does not make enough insulin or cannot use it '
      + 'properly. Insulin is what allows sugar in the blood to be used for energy.',
    sections: [
      {
        heading: 'Signs that are worth getting checked',
        paragraphs: [
          'Common early signs include being much thirstier than usual, passing urine more '
          + 'often — particularly at night — feeling very tired, losing weight without '
          + 'trying, blurred vision, and cuts or sores that are slow to heal.',
          'None of these on their own means a person has diabetes. Plenty of other things '
          + 'cause each of them. They are a reason to have a test rather than a conclusion.',
        ],
      },
      {
        heading: 'What a blood sugar test involves',
        paragraphs: [
          'A small drop of blood is taken from a fingertip and read by a meter. It takes a '
          + 'few minutes.',
          'What the result means depends on when you last ate, what else is going on, and '
          + 'your history — which is why a reading is a starting point for a conversation '
          + 'with a health professional rather than an answer in itself.',
        ],
      },
      {
        heading: 'Living with it day to day',
        paragraphs: [
          'People who have diabetes usually manage it through some combination of what they '
          + 'eat, physical activity, regular monitoring, and medicine. The balance differs '
          + 'from person to person and changes over time.',
          'Regular check-ups matter, including for the eyes and the feet, because diabetes '
          + 'can affect both gradually and without early discomfort.',
        ],
      },
      {
        heading: 'Talking to your pharmacist',
        paragraphs: [
          'A pharmacist can go through how and when to take your medicines, what to do if '
          + 'you miss a dose, and how to store them. They can also tell you whether '
          + 'something you have bought over the counter is likely to interact with what you '
          + 'already take.',
        ],
      },
    ],
    seekCare: {
      heading: 'When to seek care straight away',
      intro: 'Go to a hospital or call for help if you or someone else has:',
      items: [
        'vomiting that will not stop, with deep or rapid breathing',
        'confusion, unusual drowsiness, or difficulty waking',
        'a very high blood sugar reading together with feeling unwell',
        'signs of very low blood sugar — shaking, sweating, confusion — that do not improve after eating or drinking something sugary',
        'a wound on the foot that is not healing, or that is hot, swollen or discoloured',
      ],
      closing: 'Diabetes emergencies can develop quickly. It is always better to be seen.',
    },
  },

  {
    slug: 'malaria',
    title: 'Malaria: testing before treatment, and when to act fast',
    summary: 'Why a test matters before treating malaria, and the signs that need urgent care.',
    status: STATUS.PENDING_REVIEW,
    author: null,
    reviewer: null,
    reviewedAt: null,
    updatedAt: '2026-09-08',
    relatedServices: ['health-screening', 'medication-counselling'],
    relatedArticles: ['medicine-safety'],
    intro:
      'Malaria is caused by a parasite spread through the bite of an infected mosquito. It '
      + 'is common in Nigeria and it can become serious quickly, particularly in young '
      + 'children and in pregnancy.',
    sections: [
      {
        heading: 'Why a test comes first',
        paragraphs: [
          'Fever is the symptom most associated with malaria, but many other illnesses cause '
          + 'fever too, and they need different treatment. Treating for malaria without '
          + 'testing means the real cause may go untreated while time passes.',
          'It also matters at a wider level. Using antimalarial medicines when they are not '
          + 'needed contributes to the parasite becoming resistant to them, which makes the '
          + 'medicines less useful for everyone. A test is quick and it answers the question.',
        ],
      },
      {
        heading: 'What people commonly experience',
        paragraphs: [
          'Symptoms often include fever, chills, headache, aching muscles, tiredness, and '
          + 'sometimes nausea or vomiting. They can come and go, and they can be mistaken '
          + 'for other common illnesses.',
          'Symptoms usually begin some days to weeks after being bitten, so a recent trip to '
          + 'an area with more malaria is worth mentioning to whoever sees you.',
        ],
      },
      {
        heading: 'Finishing the course',
        paragraphs: [
          'If you are given treatment, take the full course exactly as instructed even if '
          + 'you feel better partway through. Stopping early can leave parasites behind and '
          + 'the illness can return.',
          'If the medicine is making you feel unwell or you are struggling to finish it, ask '
          + 'a pharmacist rather than simply stopping.',
        ],
      },
      {
        heading: 'Reducing the risk of being bitten',
        paragraphs: [
          'Sleeping under an insecticide-treated net, using screens on windows, wearing '
          + 'covering clothing in the evening, and removing standing water around the house '
          + 'where mosquitoes breed all reduce exposure.',
          'If you are pregnant, ask a health professional about what is recommended for you '
          + 'specifically, because the advice differs.',
        ],
      },
    ],
    seekCare: {
      heading: 'When to seek care straight away',
      intro: 'Malaria can become severe quickly. Go to a hospital immediately if you or someone else has:',
      items: [
        'a fever in a child under five, or in anyone who is pregnant',
        'confusion, drowsiness, or difficulty waking',
        'a fit or convulsion',
        'difficulty breathing',
        'repeated vomiting, or being unable to keep fluids down',
        'very dark urine, or passing little or no urine',
        'yellowing of the eyes or skin',
      ],
      closing: 'Do not wait to see whether these settle, and do not treat them at home.',
    },
  },

  {
    slug: 'medicine-safety',
    title: 'Using medicines safely at home',
    summary: 'Storing medicines, finishing courses, avoiding interactions, and buying from a registered pharmacy.',
    status: STATUS.PENDING_REVIEW,
    author: null,
    reviewer: null,
    reviewedAt: null,
    updatedAt: '2026-09-08',
    relatedServices: ['medication-counselling', 'prescription-refills'],
    relatedArticles: ['hypertension', 'diabetes'],
    intro:
      'Most problems people have with medicines are not caused by the medicine itself. They '
      + 'come from how it is stored, how it is taken, or from combinations nobody checked.',
    sections: [
      {
        heading: 'Buy from a registered pharmacy',
        paragraphs: [
          'Falsified and substandard medicines are a real problem, and they are difficult to '
          + 'identify by looking at the packet. Buying from a registered pharmacy is the '
          + 'single most effective thing you can do about it.',
          'If a price seems unusually low, if the packaging looks wrong, or if the tablets '
          + 'look different from what you have had before, bring it to a pharmacist rather '
          + 'than taking it.',
        ],
      },
      {
        heading: 'Storing medicines at home',
        paragraphs: [
          'Heat and humidity damage many medicines. A cool, dry place out of direct sunlight '
          + 'is better than a windowsill or a bathroom.',
          'Keep everything out of reach of children, including things that seem harmless. '
          + 'Keep medicines in their original packaging, because that is what carries the '
          + 'name, the instructions and the expiry date.',
          'Check expiry dates from time to time and ask a pharmacist how to dispose of what '
          + 'has passed them. Old medicines should not simply be thrown where a child or an '
          + 'animal could reach them.',
        ],
      },
      {
        heading: 'Finish what you were told to finish',
        paragraphs: [
          'Feeling better is not the same as being better. With antibiotics in particular, '
          + 'stopping early can leave the infection able to return, and it contributes to '
          + 'bacteria becoming resistant — which affects everyone, not only the person who '
          + 'stopped.',
          'If side effects are making a course hard to finish, tell a pharmacist. That is a '
          + 'solvable problem far more often than people expect.',
        ],
      },
      {
        heading: 'Do not share, and do tell someone what you take',
        paragraphs: [
          'A medicine prescribed for one person may be wrong or unsafe for another, even '
          + 'with what looks like the same illness. Dose, other conditions and other '
          + 'medicines all matter.',
          'When you see a pharmacist or doctor, mention everything you take — including '
          + 'things bought without a prescription, herbal preparations and supplements. '
          + 'Interactions are one of the commonest avoidable problems, and they can only be '
          + 'checked against a complete list.',
        ],
      },
    ],
    seekCare: {
      heading: 'When to seek care straight away',
      intro: 'Go to a hospital or call for help if you or someone else has:',
      items: [
        'difficulty breathing, swelling of the face, lips or throat, or a spreading rash after taking a medicine',
        'taken more of a medicine than intended, or swallowed someone else\'s medicine',
        'a child who may have swallowed any medicine, even if they seem well',
        'severe vomiting, confusion or fainting after starting something new',
      ],
      closing: 'With a suspected overdose or a child, take the packaging with you and go immediately. Do not wait for symptoms.',
    },
  },
];

/**
 * Is this article safe to put on a pharmacy's public website?
 *
 * THE GATE. Approval is not a label somebody can set in passing — it requires
 * a named reviewer and a review date, because "Medically reviewed by" is a
 * claim about a real person and software must not be able to make it alone.
 * An article marked approved without a reviewer is treated as NOT publishable
 * rather than trusted, so the failure is a missing page rather than a
 * fabricated credential.
 */
function isPublishable(article) {
  if (!article || article.status !== STATUS.APPROVED) return false;
  if (!article.reviewer || !article.reviewer.name) return false;
  if (!article.reviewedAt) return false;
  return true;
}

/** Every article, whatever its status. For an editorial view, not for publishing. */
function allArticles() {
  return ARTICLES.map((a) => ({ ...a }));
}

/**
 * The articles a pharmacy is allowed to publish.
 *
 * This is what pages.js is handed. Anything not approved simply is not in the
 * list, so an unreviewed article cannot become a page by any route — there is
 * no flag on the pharmacy side that overrides it.
 */
function publishableArticles() {
  return ARTICLES.filter(isPublishable).map((a) => ({ ...a }));
}

/** One article by slug, or null. Does not check status; callers decide. */
function getArticle(slug) {
  const found = ARTICLES.find((a) => a.slug === slug);
  return found ? { ...found } : null;
}

/**
 * The byline, or null when there is nobody to name.
 *
 * Returns null rather than "Reviewed by our team" or any other placeholder. A
 * vague attribution is still an attribution, and a reader has no way to tell
 * it from a real one.
 */
function bylineFor(article) {
  const out = {};
  if (article?.author?.name) {
    out.author = [article.author.name, article.author.title].filter(Boolean).join(', ');
  }
  if (article?.reviewer?.name) {
    out.reviewer = [article.reviewer.name, article.reviewer.title].filter(Boolean).join(', ');
    out.reviewedAt = article.reviewedAt || null;
  }
  return Object.keys(out).length ? out : null;
}

module.exports = {
  STATUS,
  ARTICLES,
  GENERAL_DISCLAIMER,
  allArticles,
  publishableArticles,
  getArticle,
  isPublishable,
  bylineFor,
};
