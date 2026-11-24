# AGENTS.md

Guidance for anyone changing this repo, human or agent. See [README.md](README.md).

- **A public, reusable package.** No organization-specific URLs, names or IDs in package code; take them as options.
- **No runtime dependencies.** The core talks to no service: parameters are read through the `readSsmParameter` function the caller passes. Integrations (`/ssm`) live in their own entry point, with their SDK as an optional peer dependency.
- **Never put values in errors.** Values are often secrets. Errors name variables and parameters only; don't pass on messages that may quote a value, such as `JSON.parse`'s. Tests check this.
- **Explicit over clever.** Every variable is mapped by name; nothing is inferred from parameter paths or from the schema. The schema is only called through the Standard Schema `validate` method, never through a validator's own API.
- **Readable code.** One statement per line, named checks with specific errors, descriptive names, named constants, and comments that explain why.
- **Releases:** bump the version in the PR that should publish it. Breaking changes need a major version (a minor one while below 1.0).
- **CI runs on GitHub-hosted runners.** npm provenance requires it.
- **No AI attribution in commits or PRs:** no `Co-Authored-By` trailers for AI tools, no "Generated with …" lines and no session links.

## Checks

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```
