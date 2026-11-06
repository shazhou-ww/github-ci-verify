# Project Guidelines

## Development

- This project builds the github-ci-verify ESM TypeScript CLI and API. Keep
  public exports in `src/index.ts`, tests in `test/`, and generated files in
  `dist/`.
- Use Node.js 22.13 or newer and pnpm 11.22 or newer.
- Install dependencies with `pnpm install`.
- Run `pnpm check` before submitting changes; it includes package-shape
  validation through `pnpm lint:package`.
- Preserve the package `exports` map and `files` allowlist when changing the
  build or package metadata.

## Skills

- Manage project skills with `npx skills`.
- Keep all project skills under `.agent/skills/<skill-name>/`, with each skill's
  `SKILL.md` in its directory.

## Publishing

- Keep the package private until its metadata and release setup are
  intentionally configured for publication.
- The inherited publish workflow rejects private packages. Configure Trusted
  Publishing deliberately before enabling releases; do not introduce long-lived
  npm tokens.
