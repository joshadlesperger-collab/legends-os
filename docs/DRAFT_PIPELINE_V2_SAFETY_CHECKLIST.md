# Draft Pipeline V2 — nonproduction safety and dry-run checklist
- [x] Read main branch and existing operating rules (2026-11-01).
- [x] Identify existing CI workflow and recent run evidence.
- [x] Create isolated feature branch.
- [ ] Identify deployed revision, Windows scanner folder, orchestrator schedule, and historical bulk-upload artifacts.
- [ ] Export read-only candidate manifest of 10 cards with front/back checksums; no photo moves.
- [ ] Read-only reconciliation of SKU against existing eBay drafts and listings.
- [ ] Schema validate 10 synthetic or authorized existing records; test missing serial, wrong parallel, swapped images, duplicate SKU, retry-after-timeout.
- [ ] Verify no external POST/PUT/PATCH/DELETE calls occur during dry-run.
- [ ] Run npm run validate and npm run build on implementation checkout.
- [ ] Record test output, actual cost, elapsed time, and exceptions.
- [ ] Obtain explicit approval for a single unpublished eBay test write.
Do not mark any unexecuted test as passed.
