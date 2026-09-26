# Module launcher and workspaces — information architecture

**Status:** Phase 1 in progress on `feat/refill-engine` (local). Not merged, not deployed.
**Scope:** reorganise existing screens into five modules. No new functionality,
no new data models, no business-logic changes.

---

## 1. Audit — how navigation works today

| Mechanism | Where | Notes |
|---|---|---|
| One `tab` state string, mirrored to `?tab=` | `App.jsx` | The only router. `architecture.test.js` forbids a second one (no react-router). |
| `SECTIONS` — a flat rail, one group with segments | `App.jsx:56` | Overview, AI, Consult, Manage Deals (Inbox/Orders/Requests), Patients, Website, Inventory (Products/Upload) |
| `SETUP`, `BILLING` — foot of the rail | `App.jsx:126–135` | Global, not daily work |
| `HOME` — launcher, five tiles | `Launcher.jsx` | Stock, Clinics, Patients, Marketing (Soon), Branding. Each tile opens ONE existing tab. |
| Cross-links between screens | `onNavigate(tabId)` | `AiPerformance`, `CustomerProfile`, `NotificationBell`, `BusinessInfo`. All by tab id. |
| Settings has its own internal rail | `Settings.jsx` | Your pharmacy · Customer contact · WhatsApp · Stock sync |
| Screens nested inside other screens | `Customers.jsx` | Refill call list and chronic register render above the patient list |

**Consequence for this work:** every screen already has one component and one
data source. Reorganising is a matter of *which sidebar shows which tab id* —
no component is copied, and no data is duplicated.

---

## 2. Mapping — CURRENT FEATURE → MODULE → SCREEN

Tab ids are kept wherever they exist, so every bookmark, every `?tab=` URL and
every `onNavigate(...)` call in the app keeps landing where it did.

### STOCK
| Current feature | Today | New screen (tab id) |
|---|---|---|
| Business overview: growth, top products, approval | Overview | **Overview** (`overview`) |
| Catalogue, selling points, wholesale price tier | Inventory → Products | **Catalogue** (`inventory`) |
| Spreadsheet upload, column detection, cleaning, NAFDAC lookup, duplicate review | Inventory → Upload | **Upload** (`inventory-upload`) |
| Stock sync agent, POS sync, cloud catalogue by email | Setup → Stock sync | **Stock sync** (`stock-sync`, new id, same component) |
| Order queue | Manage Deals → Orders | **Orders** (`orders`) |
| Product requests / alternatives | Manage Deals → Requests | **Requests** (`requests`) |
| Wholesale/trade QR | Setup → Customer contact → Wholesale QR | **Wholesale** (`wholesale`, new id, same component) |
| Low-stock / expiry alerts | — | **Not built.** No sidebar entry. |

### CLINICS
| Current feature | Today | New screen |
|---|---|---|
| Consult desk, handoff queue, triage, consultation briefing, pharmacist handoff | Consult | **Consultations** (`consultations`) |
| Clinical router, safety gate, red flags, clinical filter, protocols (fever v1/v2, malaria, cough, sore throat), differentials, evidence, recommendations, NAFDAC references, audit trail | Backend only — runs inside the assistant | No screen exists. Listed in the module's service registry (below), not in the sidebar. |

**Extension point.** `CLINIC_SERVICES` in `modules.js` lists clinical services.
Each entry is `{ id, label, status }`; one with a `tab` gets a sidebar item. The
existing protocols are registered with `status: 'active'` and no tab (they run
inside the assistant). Blood pressure, glucose, malaria RDT, weight,
family planning, cholesterol, vaccination, medication review and online
consultation are **not registered** — adding one later is one line plus its
screen.

### PATIENTS
| Current feature | Today | New screen |
|---|---|---|
| Patient list, Customer 360 profile, orders, conversations, timeline, event stream, notes, tags, consent, lifecycle, retail/wholesale, condition profiles, medication journeys, refills | Patients | **All patients** (`customers`) |
| Refill call list | Inside Patients, above the list | **Refills due** (`refills`, new id, same component) |
| Chronic register (patients grouped by condition) | Inside Patients, above the list | **Conditions** (`conditions`, new id, same component) |
| New patients, follow-ups, segments | — | **Not built.** No sidebar entry. |

**Within a patient** (Phase 2): the profile's existing stacked sections become
tabs — Overview, Timeline, Orders, Medications & refills, Messages, Notes.
Same components, same data; only which one is on screen changes.

### MARKETING
| Current feature | Today | New screen |
|---|---|---|
| WhatsApp conversations, staff inbox | Manage Deals → Inbox | **Inbox** (`inbox`) |
| WhatsApp message templates | Setup → WhatsApp → Message templates | **Templates** (`templates`, new id, same component) |
| AI performance, engagement figures | AI | **AI performance** (`ai`) |
| Campaigns, reminders, segments, automations | — | **Not built.** No sidebar entry. |

**AI is not a module.** It stays a screen under Marketing (its figures are
about conversations), and the assistant itself keeps working across every
module as it does today.

**Handoff queue, triage, staff alerts** are listed under Marketing in the
brief, but they are one screen with the consult desk (`consultations`). They
stay in **Clinics**: a person waiting on a pharmacist is clinical triage, and
splitting one queue across two modules would mean two places to look.

### BRANDING
| Current feature | Today | New screen |
|---|---|---|
| Website builder: templates, themes, GrapesJS, pages, health articles, AI writing, SEO, sitemap, robots, analytics, publish, subdomain | Website | **Website** (`website`) |

Phase 3 can lift the Website panel's own tabs (Overview · Content · Design ·
Settings) into this sidebar. Until then they stay inside the panel.

### Global — not in any module
| Feature | Where |
|---|---|
| Setup (WhatsApp pairing, send message, assistant, hours, public number, retail QR) | Gear at the foot of every sidebar, as today |
| Billing | Foot of every sidebar, as today |
| Search, notification bell, sound, account menu | Top bar, as today |
| "Someone is waiting" banner | Top of every screen, as today |

On Setup and Billing the sidebar lists the five modules, so there is always a
way back into a workspace.

---

## 3. Rules this design keeps

- **One component per screen.** A screen reachable from two places is the same
  component reading the same endpoint — never a copy.
- **Same entities everywhere.** An order opened from Stock or from a patient's
  profile is the same `orders` row; a conversation opened from Marketing or a
  patient is the same `conversations` row. No new tables.
- **Nothing is deleted.** Every existing screen has a home; old tab ids still
  resolve.
- **No invented screens.** A sidebar item exists only where a real screen
  does. Unbuilt items from the brief are listed above as not built.

---

## 4. Launcher tiles — live status

One line per tile, from data that already exists:

| Module | Status line | Source |
|---|---|---|
| Stock | Orders waiting to be confirmed | `/api/summary` (existing) |
| Clinics | People waiting on a pharmacist | `/api/summary` (existing) |
| Patients | Refills due today | `/api/refills` (existing) |
| Marketing | Open conversations | `/api/summary` — **one new count** over the existing `conversations` table |
| Branding | Website live / draft / not set up | `/api/website` (existing) |

The only server change in the whole reorganisation is that one added count.

---

## 5. Phases

| Phase | What changes | Risk |
|---|---|---|
| **1** | `modules.js` as the single map; module-scoped sidebar; launcher with live status; breadcrumb Home / Module / Screen; four screens given their own tab ids | Navigation only |
| **2** | Patient profile sections → tabs | Presentation of one screen |
| **3** | Website panel's tabs lifted into the Branding sidebar | Presentation of one screen |
