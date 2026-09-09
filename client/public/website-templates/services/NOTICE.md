# Service photograph sources

Real photographs used on the published website's home-page services section,
for the two service categories a clean, safely-licensed match exists for. See
`server/services/website/blocks/servicePhotos.js` for how a service name is
matched to one of these.

Both are re-encoded (resized to 640×480, JPEG q72) from the originals below —
not redistributed unmodified — which both source licenses explicitly permit.

## prescription-refills.jpg

- Source: [Estradiol valerate in pile.jpg](https://commons.wikimedia.org/wiki/File:Estradiol_valerate_in_pile.jpg), Wikimedia Commons
- License: CC0 (public domain dedication) — no attribution required
- Author: Wikimedia Commons contributor "PW"

## blood-pressure-check.jpg

- Source: [Sphygmomanometer&Cuff.JPG](https://commons.wikimedia.org/wiki/File:Sphygmomanometer%26Cuff.JPG), Wikimedia Commons
- License: Public domain (author-released) — no attribution required
- Note: cropped specifically to exclude a small manufacturer's tag visible in
  the original — not because of a license issue, but to keep the image
  generic rather than a promotional shot for one specific product.

## Why there are only two

These two are keyed by CATEGORY now (`pill`, `heart` — see
`servicePhotos.js`), the same category `blocks/icons.js` sorts a service
into, so they already cover more than their original two exact service
names: any custom-typed service that reads as medicine/prescription/refill-
related gets the tablets photo, not just the "Prescription Refills" toggle.
The other five categories (droplet/blood glucose, advice/counselling,
clipboard/screening, van/delivery, syringe/vaccination) keep the drawn icon.

**Round 1 (2026-09-08)** — Blood Glucose Testing, Vaccination Services,
Medication Counselling, Health Screening, Home Delivery:

- Blood glucose meter photos found were all clearly-branded consumer products
  (visible "MICROLET"/"DEX" logos) — using a specific competitor's branded
  device on every pharmacy's site implies an affiliation that isn't real.
- Vaccine photos found were COVID-19-specifically labelled and/or included a
  person in frame — using one for a general "Vaccination Services" listing
  would misstate what's actually offered.
- Commons' free-text search returns only scanned historical journals/books
  for "counselling", "health screening" and "delivery" as photographic
  subjects.

**Round 2 (2026-09-09)**, after a direct request for full coverage — seven
more query variations per remaining category (glucose test strips, lancets,
dosage cups/spoons, blank clipboards, plain parcel boxes, unlabelled
syringes): same outcome. Results were either more scanned 19th/early-20th-
century journals and books (e.g. searching "clipboard form" returns decades
of *Federal Register* volumes — the word appears in a filing procedure, not a
photograph) or modern product photography, correctly photographed and
licensed, but under CC-BY / CC-BY-SA — which requires a visible credit. That
is a real, satisfiable license term in general, and a bad look specifically
here: a stock-photo attribution under a picture of pills is not something a
real pharmacy's customers would understand, on a business site that has no
other credits of any kind. That's a product reason to hold the PD/CC0-only
line, not just a licensing one, and it's why this stayed at two rather than
loosening the bar under a second round of pressure to find more.

Adding a real photo for one of the remaining five later is a matter of
finding one that clears the same bar, dropping the file here, and adding one
line to `servicePhotos.js`'s `PHOTOS` map, keyed by the category it belongs
to — nothing else needs to change.
