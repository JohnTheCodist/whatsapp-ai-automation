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

Six other service categories (Blood Glucose Testing, Vaccination Services,
Medication Counselling, Health Screening, Home Delivery, Minor Ailment
Support) were searched and rejected or came up empty:

- Blood glucose meter photos found were all clearly-branded consumer products
  (visible "MICROLET"/"DEX" logos) — using a specific competitor's branded
  device on every pharmacy's site implies an affiliation that isn't real.
- Vaccine photos found were COVID-19-specifically labelled and/or included a
  person in frame — using one for a general "Vaccination Services" listing
  would misstate what's actually offered.
- Commons' free-text search returns only scanned historical journals/books
  for "counselling", "health screening" and "delivery" as photographic
  subjects — nothing usable came up after several search rounds.

Those categories keep the drawn icon (`blocks/icons.js`) instead. Adding a
real photo for one later is a matter of dropping the file here and adding one
line to `servicePhotos.js` — nothing else needs to change.
