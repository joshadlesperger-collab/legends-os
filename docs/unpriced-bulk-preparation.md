# Offline unpriced draft preparation — November 2, 2026

Current authority is the commerce checkout's `docs/LISTING_WORKFLOW.md` mandatory
November 1 procedure and `docs/PRICING_POLICY.md`: identify originals first;
eBay AI is description-only after correct titles/specifics; Grok owns later item
price and shipping; no invented numeric placeholders. This narrow path preserves
the existing priced exporter and all live writer/verification/archive gates.

Run from this operational checkout:

```powershell
node --experimental-strip-types scripts/prepare-unpriced-bulk-draft.ts --cards ID,ID --out NEW_FILE.json
```

The command only reads the current queue, selected original bytes, hosted-photo
cache and seller-review history, then writes one new local artifact. It does not
upload images, call models, alter the queue, create eBay drafts or move photos.
Existing/uncertain creation history stays excluded. Source-bound review events
require normal supported preflight rather than being reinterpreted here.

This bounded helper supports distinct numbered captures only; unnumbered captures
continue through the existing quantity planner. Each prepared transport row uses
`Action=Draft`, blank Price and blank Description. No shipping charge is generated.
Actual hosted media must be upright, bound to original hashes and valid for more
than 24 hours. Missing media produces a per-card exception while retaining fields.

`transportCsv` is an offline transport artifact, never upload authority. Even if
present, `canUpload`, `canPublish` and `submissionReady` stay false. Complete fresh
four-scope duplicate checks, supported pricing deferral and writer creation intent
before any authorized import. Review descriptions and saved policies in the native
editor, save/reopen the same IDs, then retain receipts and archive through supported
flows. Never treat CSV generation as an editable Seller Hub draft or a finished batch.
