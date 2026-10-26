# RAWtisserie — notes for contributors

See README.md for the architecture overview and commands.

- **Edit params exist twice**: `crates/pipeline/src/params.rs` (source of truth) and
  `packages/pipeline/src/params.ts`. Change both together. `npm test -w @rawtisserie/pipeline`
  asserts the defaults match (it needs a fresh `npm run build:wasm`).
- **Photo metadata** is mirrored the same way: `crates/pipeline/src/metadata.rs` ↔
  `packages/pipeline/src/metadata.ts`.
- After changing Rust code used from JS, run `npm run build:wasm` (output is gitignored).
- The server runs TypeScript directly with Node's type stripping (no build step): use
  `.ts` import extensions, `import type` for types, and no enums/namespaces/parameter
  properties (`erasableSyntaxOnly`).
- DB schema changes: add a new numbered SQL file in `apps/server/migrations/` (never edit
  applied ones), then `npm run db:schema -w @rawtisserie/server` to regenerate the types.
  The generated files are post-processed by `src/scripts/fix-generated-types.ts`.
- Chakra UI v3: in semantic tokens, declare `_light` before `_dark`. Chakra emits the
  condition blocks in first-seen order, and the `.dark` block must come last to win.
- The pipeline is scene-referred linear Rec.2020 until tone mapping; spatial parameters
  are in full-resolution pixels and get scaled by the render scale.
