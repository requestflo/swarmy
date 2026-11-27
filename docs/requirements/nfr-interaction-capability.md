# Non-functional requirements: interaction capability

Quality targets under ISO/IEC 25010:2023 "Interaction capability". Every number is already in swarmy's docs or code; "Checked by" says how far it is proven.

## NFR-036 · Accessibility

- Status: Proposed
- Revision: 1
- Target: WCAG 2.2 AA: text contrast 4.5:1, touch targets at least 44 px, usable at 390 px wide
- Checked by: One-off audit, not in CI

## NFR-037 · Clean dashboard

- Status: Proposed
- Revision: 1
- Target: Every route loads with no console errors and no failed requests
- Checked by: Playwright sweep, results never recorded

## NFR-038 · Time to first app

- Status: Proposed
- Revision: 1
- Target: A first app live within 10 minutes of pasting the install line
- Checked by: None; the quickstart promises it
