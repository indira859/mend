# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/indira859/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/indira859/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line patch tool for every AI edit format: unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and JSON tool calls. It finds the lines an edit names at the first of three matching tiers (exact, trailing-whitespace-insensitive, fully-trimmed), and changes every file or none. Node 22, standard library only.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is a patch file, or `-`/absent to read from standard input. Options: `--format=unified|search-replace|v4a|json|auto`, `--check` (dry run), `--strict` (exact matching only). See `SPEC.md` for the full contract.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
