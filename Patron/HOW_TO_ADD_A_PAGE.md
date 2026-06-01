# Adding a new page to Vitality

Every page shares one design system (`theme.css` + `theme.js`), so a new
page looks and behaves like the rest without copying any styling.

## 3 steps

1. **Copy the template**
   ```
   cp _template.html sleep.html      # use your own name
   ```

2. **Edit the marked spots** in your new file (search for the numbered comments):
   - `1.` the `<title>`
   - `2.` the `<h1 class="title">` and `<p class="subtitle">`
   - `3.` the page body — build with the shared classes
     (`.card`, `.btn`, `.btn-primary`, `.fieldInput`, …)

3. **Add it to the dashboard.** Open `index.html`, find the `APPS` array
   (near the top of the `<script>`) and add one line:
   ```js
   { file: 'sleep.html', name: 'Sleep', tag: 'Sleep tracking', icon: '😴' },
   ```
   Add `wide: true` to make the card span two columns.

That's it — the new page already has the three themes, the fonts, the
back-to-dashboard link, and the suite styling.

## What you get for free
- **Themes**: the Nocturne / Aurora / Daylight switcher works automatically
  and stays in sync with every other tab.
- **Components**: `.card`, `.btn*`, `.overlay`/`.panel` (modals),
  `.field*` (forms). See `theme.css` for the full list.
- **Tokens**: always style with the CSS variables
  (`var(--brand)`, `var(--space-4)`, `var(--radius-lg)`, `var(--fg)`…)
  instead of hard-coded colors/sizes, and you can never drift off-brand.

## Saving data
Each page keeps its own data in `localStorage` under a unique key, e.g.
`sleep_standalone_v1`. The dashboard ticker/cards can read it if you match
that pattern (see `statFor()` in `index.html`).
