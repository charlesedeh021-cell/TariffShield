# Importer dashboard: progress feedback & input affordances

Closes #1059, #1060, #1061, #1062.

Four small, self-contained UX fixes on the importer dashboard
(`apps/web/app/app/page.tsx`). No underlying request logic changes — every
fix is presentational or a client-side preview.

## Changes

### #1059 — Register importer busy state has no visual progress indicator
The register-importer submit button only swapped its label to
"Registering on Stellar testnet…" during the ~5s on-chain operation, with
no spinner.

- New `components/Spinner.tsx`: a small inline `animate-spin` SVG,
  `aria-hidden` (always paired with a visible text label).
- Rendered next to the busy label; shows only while `busy` is true.
- Button stays disabled during the operation. Registration request
  unchanged.

### #1060 — Tariff exposure form applies a new requirement with no preview
`TariffForm` applied a new annual-duty estimate immediately, silently
recomputing required collateral server-side.

- Compute the resulting requirement client-side with the same documented
  formula (`required = annual_duty × 10% × 50%`, scaled to stroops).
- Preview line updates live as the duty value changes and shows the delta
  from the current requirement (green for a decrease, red for an
  increase, "no change" when equal).
- Apply stays a single click; it's disabled only when the input isn't a
  positive number. The `upload-tariff-csv` request is unchanged.

### #1061 — Withdraw excess prefills the max with no indication or reset
`WithdrawCard` initialised its input to the full withdrawable excess with
no cue that this was the ceiling, and no way back once edited.

- Added a "Max &lt;amount&gt;" label above the input.
- Added a **Max** button that resets the input to the maximum; disabled
  while already at max (so it also signals the prefill *is* the max).
- Withdraw submission behavior unchanged.

### #1062 — Secondary loading state is plain text, unlike the route skeleton
Once the importer record loaded but `detail` was still fetching,
`ImporterDashboard` fell back to a bare "Loading…" paragraph.

- Extracted the skeleton markup from `app/app/loading.tsx` into a shared
  `components/DashboardSkeleton.tsx`.
- Both `loading.tsx` and the in-page detail-pending branch now render it,
  so the two loading phases look identical.
- Data-fetching sequence unchanged; skeleton disappears once `detail`
  loads.

## Commits

| Commit | Issue |
| --- | --- |
| `feat(web): add busy spinner to importer registration button` | #1059 |
| `feat(web): preview recomputed required collateral in TariffForm` | #1060 |
| `feat(web): add Max label and reset button to WithdrawCard` | #1061 |
| `feat(web): use dashboard skeleton for secondary loading state` | #1062 |

## Testing

- [ ] Register a new importer — spinner shows beside the label, button
      disabled, until the dashboard loads.
- [ ] In "Update tariff exposure", change the duty value — preview and
      delta update on each keystroke; Apply still commits in one click.
- [ ] With excess collateral, open the withdraw card — "Max" label
      matches the prefill; edit the amount down, click **Max**, input
      resets.
- [ ] Throttle the network and reload `/app` — route skeleton, then the
      same skeleton while detail loads, then the dashboard.

> Note: `npm install` was not run in this workspace, so `typecheck` /
> `lint` / `build` have not been executed locally. Please confirm CI is
> green.
