# AI scribe — ambient documentation for the consultation

**Goal (owner, 2026-10-04):** *"use AI to automate repetitive typing and reduce
the essence of typing for pharmacists — an AI scribe that listens to the
conversation and populates the Subjective box."*

The pharmacist talks to the patient instead of typing about the patient. That
is the right place for AI in this product.

---

## 1. What exists, checked before designing

| | |
|---|---|
| `services/ai/llmClient.js` | `chat()`, `isConfigured()`, `LlmUnavailable`. OpenAI-compatible, `LLM_API_URL` + `LLM_MODEL`. **Reused as-is.** |
| `services/safety/clinicalFilter.js` | Gates what the assistant says **to a patient**. Does not apply here — see §6. |
| Speech-to-text | **None anywhere.** This is the one genuinely new dependency. |
| Audio capture | **None anywhere.** No `getUserMedia`, no `MediaRecorder`. |
| `privacy.html` | Says nothing about voice. Would need a section — see §7. |
| The Subjective field | `pharmacist_consultations.subjective`, written through the existing `PATCH /consultations/:id`. **No new write path.** |

---

## 2. The shape

```
microphone  →  transcript  →  model structures it  →  REVIEW box
                                                          ↓
                                              pharmacist edits / accepts
                                                          ↓
                                              the existing PATCH, as if typed
```

Four properties this hangs on:

1. **The model never writes to the record.** It fills a review box. The
   pharmacist's accept is what calls `PATCH`, through the same contract their
   typing already uses. There is no path from the model to the database.
2. **The model only structures what was SAID.** It is not asked what the
   patient has, what to do, or what anything means. Its entire job is turning
   spoken English into the tidy history a pharmacist would have typed.
3. **No audio is stored.** Ever, anywhere. It is captured, transcribed and
   discarded. Nothing in the schema can hold it, which is how that stays true.
4. **Nothing happens without consent** — §7.

---

## 3. What it may write, and what it may not

It populates **Subjective only** — what the patient reported. That is the
section that is pure reportage and the one that is most of the typing.

It must **never** touch:

- **Assessment** — that is the pharmacist's own judgement (§13 of the
  consultation brief, and the reason the field is called an impression).
- **Objective / Vitals** — a number nobody measured is the worst thing this
  product could invent.
- **Problems, Interventions, Referral, Plan** — all decisions.
- **Conditions, Allergies, Medications, Tests** — §38: never auto-create.

A test asserts the scribe's output is only ever offered for `subjective`.

---

## 4. The invention problem, and how it is answered

An LLM asked to "write the history" will produce a *plausible* history,
including details nobody said. In a clinical record that is the whole risk.

Three things, all testable:

- **Extractive prompt.** It may only use words that were spoken. It is told
  that omitting something is correct and inventing anything is not.
- **Nothing-said is a valid answer.** A silent or unusable recording produces
  an empty box and says so — never a tidy paragraph about a patient nobody
  heard.
- **The transcript stays visible beside the draft** until accepted, so the
  pharmacist can see what was actually said next to what was written from it.
  This is the real safeguard; the prompt is only the first line.

---

## 5. Failure, which is the normal case

Every one of these ends with the pharmacist typing, exactly as today:

| | |
|---|---|
| No microphone / permission refused | Say so; the box stays typeable |
| `LLM_API_KEY` unset | The scribe does not appear at all |
| Provider down (`LlmUnavailable`) | The **transcript is still offered** — raw text beats nothing |
| Unintelligible audio | Empty draft, said plainly |
| Patient declines | The control is never shown |

The scribe is an accelerator. The screen must work identically without it.

---

## 6. Why `clinicalFilter` does not gate this

That filter exists because the assistant *answers patients*, and a model can be
talked out of its instructions by the text it is judging. Here the output goes
to a pharmacist, makes no claim, and is reviewed before it is saved. The
protection is the review step, not a pre-filter.

---

## 7. Consent — not optional, and not a UI detail

Recording a patient's voice in a pharmacy is processing health data about an
identified person. Under the **Nigeria Data Protection Act 2023** that needs a
lawful basis and the patient needs to know.

So:

- The mic does not open until the pharmacist confirms the patient was told.
- Consent is recorded on the consultation (who, when) — not as a tick nobody
  can trace.
- Audio is never stored, which removes the largest part of the exposure.
- `privacy.html` gains a section saying plainly: we may transcribe a
  consultation with your agreement, we do not keep the recording, and you can
  say no and be treated the same.

**This is a real obligation, not caution.** I will build the consent gate as
part of phase 1 rather than after.

---

## 8. Decided (owner, 2026-10-04)

**Whisper** — but **NOT on the key already in `server/.env`, and I was wrong
to say it would be.** I recommended it on the basis that it reused the
configured provider. It does not:

```
LLM_API_URL = https://api.deepseek.com/v1/chat/completions
```

The chat model here is **DeepSeek**, which has **no audio endpoint at all**.
Deriving a transcription URL from that, as the first version of
`scribe.js` did, would have POSTed a patient's recording to a path that
does not exist on a provider that never offered the service.

So transcription is configured **separately**, which it should have been
anyway — they are two different services:

```
TRANSCRIPTION_API_KEY   an OpenAI key (NEW — this is the cost of the choice)
TRANSCRIPTION_API_URL   defaults to OpenAI Whisper
TRANSCRIPTION_MODEL     defaults to whisper-1
```

Chat stays on DeepSeek. Only the audio goes to OpenAI.

**Unset is the committed default and is safe**: with no transcription key
the scribe does not appear and the Subjective box is typed exactly as it is
today. Nothing about the consultation depends on it.

If a second provider is not wanted, the alternatives are a DeepSeek-
compatible STT (there is none today), Deepgram or AssemblyAI (both also a
new key, both with real speaker diarization, which Whisper lacks — see
below), or the browser API with its own trade-offs.

**Straight to ambient** — both voices, as asked.

### The thing I have to be straight about: Whisper does not label speakers

`/v1/audio/transcriptions` returns the words, not who said them. There is no
diarization on that endpoint. So a transcript of a two-person conversation
arrives as one run of text.

That matters here, because Subjective is specifically *what the PATIENT
reported*. Asking a model to decide which lines were the patient is asking
it to guess — and a guess that lands in a clinical record as "the patient
said" is exactly the invention §4 exists to prevent.

So:

- The prompt is told the transcript is unlabelled, and that where it cannot
  tell who said something it must **leave it out**. Omitting is correct;
  attributing wrongly is not.
- **The transcript is shown beside the draft, always.** This is the real
  safeguard. A pharmacist who was in the room can see in two seconds whether
  the draft matches what was said.
- The draft is never saved by the scribe. The pharmacist accepts it.

Real diarization needs a different provider (AssemblyAI, Deepgram, or
Whisper plus a separate speaker model). That is a provider decision, not a
code change, and the seam below makes it a one-file swap if the unlabelled
transcript turns out to be too blunt in practice.

### The seam

`transcribe(audio) -> text` is one function with one caller. Swapping
provider, or adding diarization later, touches that file and nothing else.

## 8b. Superseded — the original question

Speech-to-text means audio leaves the device. There is no on-device option
that is realistic here.

| | Audio goes to | Accents / medicines | Cost | New key |
|---|---|---|---|---|
| **Whisper** (recommended) | OpenAI, the provider already configured | Good | ~$0.006/min | No — same key |
| **Browser Web Speech** | **Google**, a second processor | Poor on Nigerian English | Free | No |
| **Neither yet** | — | — | — | — |

Whisper is recommended: one processor instead of two, materially better on
Nigerian English and drug names, and it reuses the key already in `.env`.

---

## 9. Phasing

1. **Phase 1 — dictation + consent.** Mic, consent gate, transcript, structured
   draft, review-and-accept into Subjective. The pharmacist's own voice first.
2. **Phase 2 — ambient.** Both voices, speaker separation, longer recordings.
3. **Phase 3 — elsewhere.** The same review-and-accept pattern for other free
   text, if phase 1 earns it.

Phase 1 is the whole mechanism; phase 2 is more audio through it.

---

## 10. Tests

The contract (what may be written, nothing-said, failure modes) is
database-free. The consent record and the unchanged write path need a database.
Browser-verified end to end, including refusing the mic.

Baseline updated in the same commit, per AGENTS.md.

---

## 11. Verified against the live provider, 2026-10-05

A Deepgram key is configured (`TRANSCRIPTION_API_KEY` in `server/.env`,
gitignored). Everything below was run against the real API, not mocked.

| | |
|---|---|
| Auth | `GET /v1/projects` → **200** |
| `nova-3` on this tier | **yes** |
| 2.2 MB WAV through `transcribe()` | **3.3 s**, 7 turns |
| 17.7 MB WAV through `transcribe()` | **7.9 s**, 24 turns |
| Request carries `diarize=true&utterances=true` | **yes** |
| Response utterance keys | `start, end, confidence, channel, transcript, words, speaker, id` |
| Word-level speaker labels | **present** |

**Speed matters more than it looks.** 17.7 MB — far longer than any
consultation — came back in under eight seconds. A pharmacist is not going
to be left waiting at the counter.

### What the live run did NOT prove, and why

Both of Deepgram’s public samples turned out to be **monologues** — one
speaker, so `diarised: false` and `speakers: [0]`. That is the correct
answer for them (one voice is not separation), but it means the two-voice
path was not exercised against real audio.

What WAS proved live is that the mechanism is running: the request carries
the flags, and the response carries a `speaker` field on every utterance
and every word. The two-speaker behaviour is covered by unit tests against
a payload shaped like the real one — and the real shape has now been
confirmed to match.

The honest statement: **separation is wired and live; multi-speaker
accuracy on a real Nigerian pharmacy counter is still unmeasured.** That is
the first thing to check once the UI can record, and it is the kind of
thing that is wrong in ways no unit test predicts — background noise, two
people talking over each other, a third voice in the shop.

### Cost, measured rather than estimated

Deepgram bills by audio minute, not by megabyte. A five-minute consultation
is a few naira. The free tier this key is on expires in two days, so a paid
key is needed before this is useful to a real pharmacy.

---

## 12. Built, 2026-10-10 — the route, the consent gate and the screen

Phase 1 (the contract and the service) was recorded in §8–§11. This is the
half that touches a patient.

### What was added

| | |
|---|---|
| `0071_scribe_consent.sql` | two columns on `pharmacist_consultations`, and **nothing that could hold a recording** |
| `services/ai/scribeInput.js` | the drafting request contract — pure |
| `routes/consultations.js` | three endpoints: consent, listen, draft |
| `client/src/scribeFormat.js` | every sentence the screen says — pure |
| `client/src/ConsultationScribe.jsx` | the panel, inside the Subjective section |
| `clinicalAudit` + `patientEventTypes` | `CONSULTATION_SCRIBE_USED` |

### Three requests, not one

```
1. consent   the patient is told, and that is written down
2. listen    audio in, speaker-separated turns out, NOTHING drafted
3. draft     the pharmacist has said which voice is the patient
```

Step 2 stops short on purpose. The one question a model must not answer is
WHICH VOICE IS THE PATIENT, because its answer lands in a clinical record as
"the patient reported". A person answers it, in one tap, between the requests.

**Nothing in the feature writes to the note.** The draft comes back to the
screen and the pharmacist accepts it through the ordinary `PATCH`, so the note
has exactly one writer and a draft nobody accepted leaves no trace. Pinned
structurally in `consultationLayout.test.js`, and mutation-checked.

### Why the client sends the transcript back

The obvious design keeps the transcript server-side between requests and hands
the browser an id. That is a stored transcript of a patient consultation —
exactly what 0071 says this feature does not keep. A row with a short lifetime
is still a row, and the one that fails to be deleted is the one that matters.

The trade is worth stating plainly: an authenticated member of staff can post
text that never came from a recording and have the model structure it. That
costs a few tokens and produces a draft only they can see, in a box they could
have typed into anyway. Smaller price than a table of recordings of real
patients.

### Consent has no role gate, and finalising still does

The person who asks the patient is the person standing in front of them, and
in a Nigerian community pharmacy that is often a technician or an intern.
Requiring a pharmacist would mean waiting for one or — far more likely — the
nearest person clicking it on their behalf, which is a **worse record than the
true one**. Finalising the note is untouched and still needs a pharmacist.

A finalised note is refused: there is nothing left to write into, so a
microphone opened against one could only produce a draft with nowhere to go.

---

## 13. What driving the real thing changed

Everything below was found by running the endpoints and the live providers, not
by reasoning about them. All four were invisible to a green test suite.

### 13.1 A provider outage read as "Something went wrong"

`LlmUnavailable` carries no `status`, so an unreachable transcription provider
became a **500** with a masked message. A pharmacist at a counter learned
nothing — least of all the thing that was true: the microphone is no use right
now and the note has to be typed. Degrading to typing is the entire design of
this feature.

Fixed as a **503** with the sentence that says so, following the shape
`routes/pharmacies.js` and `routes/website.js` already use.

**And that exposed a defect in those two files.** `errorHandler` masks EVERY
5xx message (`safe = status < 500`), so their carefully written 503 wording —
*"AI writing is not available right now. Try writing it yourself instead."* —
has never reached a user either. The real distinguishing property was never the
status code; it is whether **a person wrote the sentence**. `expose` is now
opt-in, nothing else sets it, and a closed-list test keeps it that way.

**Those two routes are deliberately NOT fixed here.** It belongs in a change
about them, not a footnote in this one.

### 13.2 The absence rule refused almost every honest draft

The sharpest finding. Measured against the live model on a realistic
consultation:

```
patient said   "No fever."   "No I do not smoke at all."
model wrote    "No fever. Did not smoke."
old rule       REFUSED — as an invented negative
```

That is a faithful quotation being thrown away, and it is **not an edge case**:
a pharmacist asks "any fever?" and the patient answers. The rule would have
refused nearly every real draft while looking perfectly safe against all 12
tests.

**Why it is now safe to be precise.** The regex was written when the model saw
the WHOLE conversation and could invent an absence from nothing. It now sees
only the patient's own words. So a negative that also appears in those words is
QUOTED, and the question stops being "does this look like a negative finding"
and becomes the answerable one: **did the patient say it?**

This is **stricter** where it matters. A fabricated "no known allergies" is
still refused — now because the words are not there rather than because the
phrase matched a list, which also catches phrasings nobody thought to add
("Not diabetic", "has never had tuberculosis").

Three things its own tests then caught:

- **Mentioning is not denying.** The first version asked only whether the
  source negated *anything* and mentioned the subject *anywhere*, so "I have
  no fever" licensed a drafted "No chest pain" on a patient who had merely
  mentioned their chest. The denial and the subject must now arrive in the
  **same** source sentence.
- **Blanket claims can never be supported.** "No other symptoms" asserts the
  absence of things nobody named; "unremarkable" asserts a review of systems
  that did not happen. No patient sentence could license either, so they are
  refused outright even when the transcript is full of denials.
- **A bare negative is refused.** Found by MUTATION, not by writing the test:
  making a subjectless negative "supported" left every test green. "None." or
  "Not recorded." in a Subjective box is the allergy card's "None" (0058) in
  the worst possible place, and it cannot be checked because it does not say
  what it is about.

### 13.3 The model returned nothing, and the screen called it silence

`finishReason: 'length'` with **zero characters of content**, on every
realistic transcript. This deployment's chat model spends tokens REASONING
before it answers; they count against the budget and never appear in
`content`, so `maxTokens: 400` was consumed entirely by thinking.

An empty answer is otherwise legitimate — a recording that caught little should
produce little — so the screen said *"the recording caught too little to draft
from"*. **That is a statement about the patient's consultation, and it was
false.** The recording was fine; the assistant was interrupted.

Truncation now has its own refusal and its own sentence, and the budget is
1200: headroom for the thinking, not for the answer.

### 13.4 An all-blank transcript claimed the recording was empty

Same class, found by the contract's own test: an array of empty turns passed
the length check, filtered to nothing, and reached `readTranscript`, which
refused it as `too_short`. The listen step only offers a draft once it has
turns with words in them, so an empty one is a broken request — and the screen
should say the request is wrong rather than inventing a quiet consultation.

---

## 14. Measured end to end, 2026-10-10

Against a local PostgreSQL 17.10 (72 migrations) and the live chat provider.

| | |
|---|---|
| Audio posted with no consent | **409** `NO_CONSENT`, refused BEFORE the provider call |
| Draft requested with no consent | **409** `NO_CONSENT` |
| Consent recorded | stored with who and when; note otherwise **untouched** (`subjective` null, status still `draft`) |
| Provider unreachable | **503**, *"Type the note instead"* — the sentence reaches the user |
| Two voices, nobody named | **400**, `field: patientSpeaker` |
| A voice not in the recording | **400**, its own sentence |
| A select's string `"1"` | accepted |
| Realistic consultation, live model | **675-character draft**, `refused: null`, correct and extractive |

The draft included "no fever" and "did not smoke" — both of which the patient
actually said, and both of which the old rule would have thrown away.

### What is still unverified, and why

- **The screen itself was not clicked through.** The dashboard requires a
  Supabase sign-in, and that is the owner's account, not something to drive
  with their credentials. The UI's logic is covered by 12 `scribeFormat` tests
  and 4 structural invariants in `consultationLayout.test.js`, all
  mutation-checked; what is NOT covered is that it looks right.
- **No microphone.** `MediaRecorder` capture, the permission prompt and the
  release-on-unmount path have never run against real hardware.
- **No two-voice Deepgram run.** The free key has expired, so the transcription
  call now fails — which is how §13.1 was found. Separation remains proven
  only against a payload shaped like the real one (§11 confirmed the shape
  live, on monologues).

**The honest summary: the safety machinery is measured and the ergonomics are
not.** Everything that decides what may reach a clinical record has been run
and mutated. Whether a pharmacist at a counter finds this faster than typing
is unknown, and is the first thing to check with a paid key and a real
consultation.

### A gap this did not close

`withinTranscript` compares CHARACTER COUNTS, which catches wholesale
fabrication (a long invented history from a short recording) and **cannot
catch a short one**. A model writing "Reports cough and vomiting" from a
transcript saying only "cough" is shorter than the source and passes. On the
realistic case the measurement was 675 against 689 — it passed, but with very
little margin.

The absence rule now grounds negatives in the patient's words. Positive
fabrication has no equivalent check, because a faithful draft legitimately
rewords ("non-productive" for "nothing comes out"), so requiring every content
word to appear would refuse everything. Closing it properly needs entity-level
grounding, which is its own piece of work and is deliberately not attempted
here.
