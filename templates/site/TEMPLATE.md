# Site scaffold

Next.js (App Router) + Tailwind + shadcn/ui, configured for static export.
Copied into every project workspace before generation.

## Why the platform owns this rather than the model

**Deterministic builds.** One hallucinated dependency version fails the build
for reasons unrelated to the site.

**`pnpm install` never runs on model-authored `package.json`.** Installing
arbitrary dependencies executes arbitrary postinstall scripts. The dependency
set here is fixed and reviewed; the model cannot extend it.

**Smaller model output.** Boilerplate is most of a Next.js project by volume,
and output size is what caused truncation failures when the builder emitted
whole sites in one response.

## Ownership

| Path | Owner | Notes |
|---|---|---|
| `app/**/page.tsx` | **Terra** | One directory per route; `app/page.tsx` is the homepage |
| `app/layout.tsx` | **Terra** | Shared shell: header, nav, footer, metadata |
| `app/globals.css` | **Terra** | Brand tokens only — the shadcn theme layer stays |
| `components/site/**` | **Terra** | Site-specific components |
| `components/ui/**` | Platform | shadcn primitives — read and compose, never edit |
| `lib/**`, `package.json`, configs | Platform | Writes here are refused |

## Static export

`next.config.ts` sets `output: 'export'`, so a build emits a real HTML file per
route into `out/` — each with its own `<title>` and meta description. That is
what makes the deterministic gates meaningful: they parse the same markup a
visitor and a crawler receive, not the source that produced it.

## Available shadcn components

`accordion` · `badge` · `button` · `card` · `input` · `label` · `separator` ·
`sheet` · `textarea`

Anything else must be composed from these plus Tailwind. A component that is
not present will fail the build, which is the intended failure mode: it is
caught by the build gate rather than shipping broken.
