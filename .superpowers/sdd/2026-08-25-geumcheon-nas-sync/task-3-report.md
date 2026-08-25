# Task 3 Report: Idempotent No-Replace NAS Record Storage and Routes

## Scope

Implemented only the Task 3 owned NAS service files:

- `services/nas-record-api/src/atomicStore.ts`
- `services/nas-record-api/src/recordStore.ts`
- `services/nas-record-api/src/app.ts`
- `services/nas-record-api/src/cli.ts`
- `services/nas-record-api/test/recordStore.test.ts`
- `services/nas-record-api/test/routes.test.ts`

No client, Electron renderer, release, `.serena`, real NAS, deployment configuration, or Task 1/2 source was changed.

## Delivered behavior

- `writeFileNoReplaceAtomic` creates a same-directory unique `0600` temporary file with `wx`, writes canonical bytes, syncs the file, publishes with `link` (never replace), removes the temporary file, then syncs the parent directory on platforms where Node supports directory handles.
- `RecordStore.put` maps only normalized official records to `기록저장/<day>일차/<round>회차/incoming/ai/<record_id>.json` and practice records to `기록저장/연습회차/incoming/ai/<record_id>.json`.
- Concurrent identical requests produce one `stored` acknowledgement and durable `duplicate` acknowledgements. Existing mismatched payload hashes produce `IDEMPOTENCY_CONFLICT`; empty, malformed, or structurally incomplete existing files produce `STORAGE_CORRUPT` without replacement.
- `POST /api/v1/records` uses the Task 2 token principal and `StoredNasRecordV1` normalization. It requires JSON, Authorization, `X-Device-Id`, and an idempotency key equal to the normalized record ID.
- The route has a 32 KiB Fastify body limit, no CORS plugin, strict top-level additional-property rejection, token and auxiliary-IP limits, safe error objects, and no path in successful or error API responses.
- `GET /health` returns exactly `{ "status":"ok" }` only when the injected loaded configuration is complete and a same-directory temporary create/sync/unlink check succeeds; otherwise it returns exactly `{ "status":"unavailable" }` with 503.
- The CLI loads Task 2 configuration, parses the configured stage catalog, and binds the Fastify service without printing configuration errors.

## TDD evidence

### RED

1. Added record-store behavior tests before storage modules. The focused runner failed with `ERR_MODULE_NOT_FOUND` for `src/recordStore.js`.
2. Added route tests before the application module. The focused runner failed with `ERR_MODULE_NOT_FOUND` for `src/app.js`.
3. Added strict unknown-field/rate-limit route coverage. It initially exposed that Fastify was removing unknown fields before the Task 2 schema validator, so the invalid request incorrectly returned 201 instead of 422.
4. Added the explicit file-sync failure-boundary test. It failed with `Missing expected rejection` for `FAULT_beforeFileSync` before that hook existed.

### GREEN

1. `npm --prefix services/nas-record-api exec -- tsx --test services/nas-record-api/test/recordStore.test.ts` passed 6/6 after atomic storage implementation.
2. `npm --prefix services/nas-record-api exec -- tsx --test services/nas-record-api/test/routes.test.ts` passed 4/4 after app implementation and explicit `removeAdditional: false` configuration.
3. Final focused command over both Task 3 test files passed 10/10 after adding the file-sync fault boundary.
4. `npm --prefix services/nas-record-api run typecheck` completed with exit code 0.

## Final verification

- `npm --prefix services/nas-record-api test` — 33 passed, 0 failed.
- `npm --prefix services/nas-record-api run typecheck` — passed, exit code 0.
- `git diff --check` — passed with no whitespace errors.

## Commit

- Commit message: `feat: store NAS records without overwrite`.
- The final commit hash is reported in the task handoff after this report is committed.

## Concerns and unrun boundary

- The tests use only synthetic record values and generated token material; no real token, participant, NAS hostname, or NAS path was written or logged.
- No real NAS, SMB/NFS mount, ACL/service identity, NAS power loss, process crash, cross-host concurrency, TLS/reverse proxy, or field network test was run. The local filesystem tests prove the Node publication protocol, not real-NAS durability.
- Node does not provide portable parent-directory `fsync` support on Windows. The implementation performs directory sync on non-Windows platforms and the readiness/atomic fault tests cover the required failure behavior; a real Synology/Linux validation remains required before claiming NAS durability.
