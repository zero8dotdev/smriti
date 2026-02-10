---
id: 0a03e5ef-f35c-481b-9dac-b6eee7422ff2
category: feature
project: zero8-dev-openfga
agent: claude-code
author: zero8
shared_at: 2026-02-10T10:46:25.750Z
tags: ["feature", "feature/implementation"]
---
# let create a proper readme file, contributing instructions and a demo video which shows how agents a
**user**: let create a proper readme file, contributing instructions and a demo video which shows how agents auth is working. and prepare for push. 
**assistant**: Let me first understand the codebase to create proper documentation.
**assistant**: Now let me read the existing files to see what's already there.
**assistant**: Now I have a complete picture of the codebase. Let me create all three files.
**assistant**: Now let me check if VHS (terminal GIF recorder) is available, and create the demo recording setup.
**assistant**: Neither recording tool is installed. Let me create a VHS tape file (the standard for GitHub terminal recordings) and a condensed demo script optimized for the recording.
**assistant**: Now let me update the README to reference the demo recording and add instructions for generating it.
**assistant**: Now let me also add `.cursor/` and `.vscode/` to the gitignore and make sure everything is ready.
**assistant**: Now let me check the git status to see what's ready for push.
**assistant**: Everything is ready. Here's what was created and updated:

**README.md** — Comprehensive documentation covering:
- Project overview with the Sharma Auto business scenario
- ASCII architecture diagram
- Full OpenFGA authorization model with explanation
- Quick start guide (docker compose + bun)
- Complete API reference (all 25+ endpoints with permissions)
- Database schema table
- Detailed explanations of deputation and instant access revocation
- Test instructions and tech stack

**CONTRIBUTING.md** — Contributor guide with:
- Development setup instructions
- Project structure breakdown
- How to report bugs and submit changes
- Code style conventions (Bun-first, Hono, minimal deps)
- Guidelines for modifying the FGA model and adding endpoints

**demo.tape** — VHS terminal recording script that generates `demo.gif`, showing:
1. Owner signup + JWT auth
2. Company registration
3. Admin creates a resource (allowed via FGA)
4. Regular employee added
5. Employee views resource (cascading `viewer` via org membership)
6. Employee blocked from creating (403 - no `admin` relation)
7. Employee terminated + FGA tuples deleted
8. Ex-employee blocked from viewing (instant revocation)

**.gitignore** — Updated to exclude `.cursor/` and `.vscode/` directories

To generate the demo GIF, install VHS (`brew install vhs`) and run `vhs demo.tape` while the server and infrastructure are running.

All files are staged and ready — would you like me to commit and push?
**user**: yes, commit
**assistant**: Committed as `d572ff1` — 22 files, 3,251 lines added. Working tree is clean.

To generate the demo GIF before pushing, you can run:
```bash
brew install vhs && vhs demo.tape
```

Want me to push to the remote?
**user**: yes, push it
**assistant**: No remote is configured yet. Do you have a GitHub repo URL to add? For example:

```bash
git remote add origin git@github.com:<username>/<repo>.git
```

Or I can create one for you with `gh repo create` if you have the GitHub CLI set up.
**user**: create one
**assistant**: Repo created and pushed: https://github.com/ashu17706/openfga-rbac-demo
**user**: brew install vh
**assistant**: VHS is installed. You can now generate the demo GIF:

```bash
vhs demo.tape
```

Make sure the server and infrastructure are running first (`docker compose up -d && bun run index.ts`).
**user**: vhs demo.tape
**assistant**: VHS doesn't support escaped quotes in `Type` commands. Let me rewrite the approach — I'll create a clean demo script that VHS just executes.
**assistant**: Now let me make the script executable and run VHS.
**assistant**: VHS ran successfully and generated `demo.gif`. Let me verify it exists.
**assistant**: The GIF is only 69K — let me check if the server is running so the demo actually produces output.
**assistant**: The server isn't running, so the GIF just captured failed curl calls. Let me check if Docker infrastructure is up, start the server, then re-record.
**assistant**: Docker is up. Let me start the API server, clean the DB for a fresh demo, then re-record.
**assistant**: Server is up. Let me first test the demo script works, then re-record.
**assistant**: Demo script works perfectly. Now let me reset the DB again and re-record with VHS.
**assistant**: 533K now — much better, the demo output was captured. Let me stop the server, commit everything, and push.
**assistant**: Done! Pushed to GitHub. The demo GIF is now live in the README at your repo. 

Note: GitHub shows the repo has moved to `git@github.com:zero8dotdev/openfga-rbac.git` — you may want to update the remote:

```bash
git remote set-url origin git@github.com:zero8dotdev/openfga-rbac.git
```
**user**: git@github.com:zero8dotdev/openfga-rbac.git
**assistant**: Remote updated. Your repo is now at `git@github.com:zero8dotdev/openfga-rbac.git`.
**user**: open the repo in browser
**assistant**: Opened in your browser.
**user**: how to run the interactive demmo?
**assistant**: API Error: Unable to connect to API (ConnectionRefused)
**user**: how to run interactive?
**assistant**: Start the infrastructure and server first, then run the interactive demo:

```bash
docker compose up -d
bun run index.ts
```

Then in another terminal:

```bash
bun run demo-interactive.ts
```

It will walk you through each step interactively — letting you choose personas, customize org/resource names, test permissions, mark attendance, and create deputations.