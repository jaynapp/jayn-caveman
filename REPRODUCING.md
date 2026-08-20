# Reproducing the numbers

Every figure in the [README](README.md) came out of one of six commands. This page maps each
one to the figure it regenerates and says what you have to bring.

You cannot reproduce our exact numbers: they were measured on other people's transcripts, which
are not ours to publish. You can run the same instruments against your own and get your own.

## Setup

```bash
npm install
npm run cli -- --help
```

Node 22 or newer. No build step; `tsx` runs the TypeScript directly. Nothing here talks to the
network unless you pass `--exact`, which sends turn text to Anthropic's `count_tokens` endpoint,
or run `trial`, which spends money.

Transcripts are read from `~/.claude/projects` by default. Every command takes `--root` to point
somewhere else, and most take a comma-separated list — one directory per contributor, which is
what produces the per-corpus rows and the leave-one-out spread:

```bash
npm run cli -- compliance --root ~/corpora/alice,~/corpora/bob
```

## The commands

| Command      | Regenerates                                                           |
| ------------ | --------------------------------------------------------------------- |
| `analyze`    | the headline (−0.026%), the sensitivity band, the prose-share ceiling |
| `compliance` | the `p_fire` table, the arm balance, the leave-one-out spread         |
| `corpora`    | the per-corpus money table                                            |
| `breakeven`  | the English-prose-per-prompt table and the crossing                   |
| `trial`      | `R`, the compression ratio — **this one spends real money**           |
| `curves`     | refits `curves/` from `data/` — the CI gate on our own numbers        |

### `analyze` — the headline and the band

```bash
npm run cli -- analyze --root <dir> --model claude-opus-5
```

Replays every session with prose scaled by `p_fire × R + (1 − p_fire)`, priced positionally, and
prints the totals with the audit trail. The `--brief` flag drops the band and the audit; do not
use it to read a headline, because the band is what says whether the headline is even signed.

`--model` restricts what `p_fire` is **estimated** from, in both arms. It does not restrict what
is priced — every turn is still replayed and billed. Vanilla terseness spans 28 points between
model families, so a curve fitted across a mixture of them partly measures the mixture.

This is the command behind "prose share of the bill", printed as the ceiling: the bound no
prose-compressing tool can beat.

### `compliance` — how often it fires

```bash
npm run cli -- compliance --root <dir1>,<dir2> --model claude-opus-5 --by-position
```

The `p_fire` table in the post is exactly this output with `--by-position`. Without that flag it
pools closing and mid-run turns, which is not what the replay charges.

It also prints, unasked:

- **arm balance** — the ON/OFF model mix, flagged when the arms differ by more than 20 points.
  Our corpus was 61 points apart on Opus 5, which is why the post restricts to one family.
- **composition** — the leave-one-contributor-out spread. On our corpus that is 45.3% to 71.6%,
  and the contributor who moves it down most holds none of the caveman-live turns. That width
  _is_ the estimate, not a robustness check it passed.
- **band definition** — what the answer would have been had cells banded on tokens instead of
  words. It records the cost of a choice the numbers cannot settle.

Two subcommands:

- `compliance fit` refits the thresholds in `curves/` straight from the transcripts under
  `--root`, skipping `data/` entirely. Use it when the transcripts are yours to read but not
  yours to publish.
- `compliance record --contributor <handle> --consent` exports your own turns as a batch under
  `data/caveman/`. See [Data](#data) for exactly what that writes.

### `corpora` — what it would do to someone who never installed it

```bash
npm run cli -- corpora --root <dir1>,<dir2>,<dir3>
```

One row per directory plus a pooled row, each priced twice over the same transcripts: once
charging the ratio to every turn (the number a single-turn benchmark reports), once with the
measured `p_fire` wired in. The sign flip between those two columns is the post's central claim.

Sessions that already ran caveman are excluded and reported separately — they carry its
injections, so replaying them reconstructs rather than projects. Sessions are restricted to
English by default; `--mixed-languages` lifts that, and the command will then be measuring an
instrument rather than the tool.

The command flags it when one corpus holds more than half the pooled bill. Ours held 84%.

### `breakeven` — the only number that transfers

```bash
npm run cli -- breakeven --root <dir1>,<dir2>
```

Buckets every session by prose tokens written per prompt sent, and reports share of bill, share
of sessions that gain, and the money-weighted result per bucket. Default edges are the post's;
`--buckets` takes your own.

This is the one output worth running on yourself before installing anything. Well under the
crossing, a per-prompt reminder cannot pay for itself; well over, it might.

### `trial` — measuring R

**This command spends money.** It launches headless Claude Code runs, two per pair. Ours was 36
runs for 18 pairs and produced 9 usable English pairs.

```bash
npm run cli -- trial init  --root <ledger dir>
npm run cli -- trial plan  --repeats 3 --langs en
npm run cli -- trial run   --root <ledger dir> --sandbox <pinned repo>
npm run cli -- trial analyze --root <ledger dir>
```

Both arms get the same prompt, the same model and the same pinned repository state. They are
isolated by `CLAUDE_CONFIG_DIR`, not by `--settings`, which merges rather than replaces and
leaks the host's hooks into the control arm. Each run's arm is re-derived from the injections in
its own transcript rather than trusted from the launcher, so a leak shows up as a discarded pair
instead of a quiet bias.

`trial run` is resumable: completed runs are keyed in a ledger and skipped. It halts rather than
grinding on when the failure is fatal (no credit, bad key, blown quota).

The mid-run stratum is **not** measurable this way and the command says so. Headless agents
barely narrate between tool calls — 2.0 prose tokens on the treated arm against 71 in a real
corpus — so its ratio is a placeholder everywhere it appears.

### `curves` — refitting the shipped thresholds

```bash
npm run cli -- curves          # rewrite curves/ from every batch in data/
npm run cli -- curves --check  # fail if the committed file is stale; writes nothing
```

`curves/` is generated and `data/` is the asset. `--check` runs in CI, so the thresholds in this
repository are provably the ones the shipped observations produce — that is the one number here
you can reproduce exactly, without any transcripts of your own.

## Data

`data/caveman/` holds the observations the shipped thresholds in `curves/` were fitted from.
Each batch is a `.jsonl` of one record per assistant turn plus a `.meta.json` sidecar.

A record is exactly this:

```json
{
  "lang": "en",
  "band": 0,
  "shape": "prose",
  "sentLen": 5,
  "index": 3,
  "last": false,
  "model": "claude-opus-4-8",
  "caveman": true,
  "batch": "b20260814-130601-hgyrh3"
}
```

Language, size band, bullet-vs-prose shape, mean sentence length, position in the session,
whether the turn closed a run, model family, and whether caveman was live. **No prose, no
paths, no repo or project names, no timestamps, no session ids.** Nothing in a batch can be
turned back into what anyone was working on — but it does describe how a person writes, which is
why `compliance record` refuses to run without an explicit `--consent`.

Contributors are named by handle in the sidecar and by opaque id in `curves/`. That is the
attribution CC BY 4.0 asks a citer to honour; see [LICENSE-DATA](LICENSE-DATA).

## What you should not conclude from a clean run

The commands print their own caveats and mean them. The short version:

- Sensitivity is taken as 1, so every `p_fire` is a **lower** bound.
- Mid-run `R` is a placeholder whose leave-one-out range straddles 1.0.
- Thinking tokens are assumed untouched, and that assumption is untested — they are ~89% of
  billed output, so if caveman does compress them every figure here understates it.
- A pooled percentage describes the heaviest spender while appearing to describe everyone.

[docs/methodology.md](docs/methodology.md) states each of these in full, with what it would take
to settle them.
