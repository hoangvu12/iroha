# Issue tracker: Local Markdown

Issues and specs for this repo live as Markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are individual files under `.scratch/<feature-slug>/issues/`
- Ticket names use `<NN>-<slug>.md`, numbered from `01`
- Each ticket records `Status:` and `Blocked by:` near the top
- Comments append under `## Comments`

## Publishing

When a skill says "publish to the issue tracker," create the relevant file under `.scratch/<feature-slug>/`.

## Fetching

When a skill says "fetch the relevant ticket," read the referenced issue path or number.

## Blocking and frontier

A ticket is unblocked when every ticket listed by `Blocked by:` is complete. The frontier is every incomplete, unblocked ticket, considered in numeric order.
