# Claude repository instructions

Read and follow `AGENTS.md` and the downstream porting procedure in `docs/UPSTREAM.md` before changing this repository.

This is a public repository. Never add Claude provenance session URLs or session trailers to
commit messages, files, release notes, logs, or generated artifacts. Maintainer commits must use
a GitHub noreply address; never use a personal mailbox or a private local path. Before every
commit, push, tag, or release, run `npm run verify:privacy`. The versioned Git hooks installed by
`npm run hooks:install` enforce the same policy for Claude-created commits.

Do not bypass these guards with `--no-verify`. If a privacy check blocks a change, remove the
private value at its source and create a new clean commit instead.

Preserve the local ChatBBC main history and upstream attribution. Do not rewrite history, push a branch, tag or publish a release without explicit authorization. The MIT license and `CONTRIBUTORS.md` retain original credit; adapted upstream or community work must credit its actual authors. Do not add automated-assistant attribution that misstates authorship or contains private session provenance.
