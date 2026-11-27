# skywave

## Testing

Run from the repo root:

- `pnpm typecheck`: TypeScript for the web app (`apps/web`).
- `pnpm test:web`: Vitest for the web app (`apps/web`, tests beside the code as `*.test.ts(x)`).
- `pnpm test:radio`: pytest for the radio service (`apps/radio/tests`) and the #61 spikes (`apps/radio/spikes`). Needs `apps/radio/.venv` (see README).

CI runs all three on every push (`.github/workflows/ci.yml`). Each test carries a
`// Value: protects=...; fails_when=...; why_new=...; seam=...; no_claim=...` card (`#` in Python).
