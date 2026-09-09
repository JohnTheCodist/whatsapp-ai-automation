# Rendered template previews

Static output of the five website templates, rendered by
`server/services/website/document.js` against a fictional pharmacy.

**Generated, not authored.** Nothing here is served to anyone and nothing
imports it — these files exist so a person can open the three designs side by
side and judge them without setting up a database, a session and a dev server.
They are a snapshot of one commit and will go stale; regenerate rather than
edit.

To regenerate, render each template through `renderDocument()` with a profile
of your choosing. The fixture used for these is the one in
`server/tests/websiteDocument.test.js`.

| File | Template | Palette / type / corners |
|---|---|---|
| `professional.html` | Professional | teal · clinical · soft |
| `modern.html` | Modern | green · bold · round |
| `premium.html` | Premium | slate · classic · sharp |
| `family.html` | Family | clay · humanist · round |
| `metro.html` | Metro | blue · bold · round |
