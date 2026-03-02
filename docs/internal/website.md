# Website Playbook

This repo now ships a manifesto / evaluation site in `/Users/zero8/zero8.dev/smriti/website`. It is a Next.js 15 App Router app that exports to static HTML so you can host it anywhere (GitHub Pages, Vercel static, Cloudflare Pages, etc.). The narrative is now tailored for CTOs: value metrics, demo paths, architecture diagram, comparison grid, security brief, rollout plan, and CTA choices.

## Install dependencies

```bash
bun install
# installs CLI + website workspaces
```

## Local development

```bash
bun site:dev
```

- Next.js dev server with hot reload for MDX, React, Tailwind.
- `/website/content/` holds MDX sections (hero, problem, outcomes, demo, architecture, comparison, memory, security, proof, rollout, CTA).
- `/website/components/` includes reusable UI blocks (FlowSection, TechAside, QuoteStrip, StatsStrip, DemoOptions, ArchitectureDiagram, ComparisonTable, ImpactGrid, PlaybookSteps, CLIBlock).

## Quality checks

| Command | Purpose |
| --- | --- |
| `bun site:lint` | `next lint` across the website workspace. |
| `bun site:check-content` | Verifies every section wiring + tech aside metadata. |
| `bun site:build` | Runs `next build && next export` (outputs to `website/out/`). |

Optionally add Playwright visual tests if you need regression coverage for the new sections.

## Deploying

Same as before—`bun site:build`, then ship `website/out/` to your hosting target. Provide environment variables for analytics if needed (none required by default).

## Updating content

1. Edit the relevant MDX file under `website/content/`.
2. If you add sections, register them inside `content/sections.ts` and update the `order` array in `app/page.tsx`.
3. Use the components so layout stays consistent.
4. Re-run the quality commands above.

## Evaluation assets

- **Metrics:** edit `StatsStrip.tsx` when you have new KPIs.
- **Demo options:** update `DemoOptions.tsx` links if the sandbox/live booking URLs change.
- **Architecture diagram:** `ArchitectureDiagram.tsx` holds the ingestion → QMD → SQLite → recall visualization.
- **Comparison table:** adjust `ComparisonTable.tsx` when competitors shift.
- **Rollout playbook:** tune `PlaybookSteps.tsx` for your actual adoption plan.

Security packet + contact info lives inside `content/security.mdx`; update when compliance status changes.
