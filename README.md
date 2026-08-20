# Caveman made us lose money, and probably you too

This repository is the measurement code behind that post. The post is reproduced below; how to
re-derive every figure in it against your own transcripts is in [REPRODUCING.md](REPRODUCING.md),
and the reasoning behind each choice is in [docs/methodology.md](docs/methodology.md).

---

Caveman, headroom, rtk... Do any of these really save tokens ? Like truly save tokens, not just
on benchmarks ? Both my cofounder and I have [caveman](https://github.com/JuliusBrussee/caveman)
installed.

As [many benchmarks](https://codepointer.dev/p/cutting-llm-token-costs-with-rtk) did
[show before us](https://blog.jetbrains.com/ai/2026/07/speak-to-ai-agents-like-cavemen-tosave-tokens/),
caveman should cut tokens, but the problem I had with those, is that the numbers they share are
just final results that I can't use for myself. What I want to know, is how much it would save
me, not how much it saved on average on 86 tasks. And I always felt something was missing from
their benchmarks.

Does caveman save you money ? Mostly not, but it depends lol. Let's deep dive into the numbers.

## TL;DR

On most corpora caveman can't save more than 3%.
If caveman did fire on every prompt, it saves you **+0.25%**.
Taking into account it has trouble firing as session grows, it costs you **−0.23%**.
Caveman reminder injections costs more than it saves below a thousand prose tokens per prompt
you send.

|                                                    | range        |
| -------------------------------------------------- | ------------ |
| prose, share of output tokens                      | 4.1% – 10.2% |
| prose, share of the bill (cache re-reads included) | 2.3% – 9.1%  |
| if caveman fired on every turn                     | **+0.25%**   |
| what caveman actually returned                     | **−0.23%**   |

## Why obvious benchmarks don't transfer

First issue : caveman compresses model prose only. Not anything else. So the first thing to
compute is the share of prose tokens that caveman can reduce.

Depending on the corpus, prose share of output tokens ranges from 4.1% to 10.2%, and prose share
of the bill ranges from 0.4% to 1.8%, counting only the turn that wrote it.

But prose is not paid for once. It gets cache-written when produced, then cache-read on every
turn after that, so its real cost grows with how long your sessions run. Accounting for that
gets us to 2.3% to 9.1% of the bill. The corpus topping that range has an average share of prose
(6.6%) but its sessions are long enough for the same tokens to be re-read hundreds of times.

The one thing not varying by a factor of 2 to 4 is that caveman CANNOT save you more than 9% of
your bill (and this is being generous). Most of the time the ceiling is 3%.

Second issue. Many benchmarks measure the tool under conditions it likes : fresh session, short
task. Real sessions can run for hundreds of turns. That difference alone moves caveman
compliance from around 78% to 13%.

So we went for a bottom-up approach : we modeled how caveman behaves and replayed it over the
vanilla transcripts we already had. But to do that, we needed to estimate some parameters first.

## Two numbers, not one

Many benchmarks only measure the compression effect of caveman. But caveman sometimes does not
trigger, if the model thinks the details are very important for instance, or maybe if the model
forgets to use it. Our model takes that into account :

```
effective_ratio(turn) = p_fire × R + (1 − p_fire) × 1.0
```

- **`p_fire`** = how often the model actually writes in caveman style. The model can ignore it,
  and does.
- **`R`** = how much shorter a turn gets given that it fired.

Every published caveman figure we found reports something in the neighbourhood of `R` and
implicitly assumes `p_fire = 1`. On a single-turn benchmark, yeah that's nearly true. On a real
session it's not.

## Measuring how often it fires

There's no easy way to see if the model complied. We need a detector for that.

On vanilla sessions, we measure the distribution of words per sentence (per turn) and set a
threshold at the 25th percentile. A "terse" turn is then one that falls below that threshold. We
then compare the distributions of turns with caveman on and off, and measure the share of terse
turns in each.

### We accounted for the fact that caveman is not always on

So every vanilla turn is by definition close to 25% of the time terse. We measure the fire rate
of caveman by comparing the caveman-on rates with the caveman-off rates. That caveman-off rate
is called the floor of the detector, because caveman-on rates shouldn't be below it. It is not
assumed to be 25% : it is measured per bin, one bin per language, size band, shape and model
family, and subtracted.

```
p_fire = (observed − floor) / (1 − floor)
```

The sensitivity is how often caveman fires and the detector misses. We can't measure, so we take
it as 1. That makes every number we report a **lower bound**.

### We reduced the scope to one model, one language

Vanilla terseness spans 28 points between model families. Worse, caveman's deletion rules name
English function words, and we measured them not firing on French at all.

So everything below is restricted to **Opus 5 and English, in both arms**: 2,275 scoreable
turns, 1,040 of them with caveman live, across three corpora. One consequence to keep in view:
the corpus we have might be small to have a stable estimate of `p_fire`.

### We need to split turns by position in the answer

We initially split turns into "pure text" versus "carries a tool call", and got a beautiful
result: pure-text compliance was flat across the whole session while tool-carrying turns
collapsed. It was wrong. Look at the cross-tab (2,275 turns) :

```
             last=0   last=1
  pure=0       1737      313
  pure=1          0      225   <- P(last | pure) = 100%
```

**Every pure-text turn is the model's closing turn.** "Pure text" was never measuring
text-versus-tools, it was a proxy for position in the answer. This matters more than a variable
rename because of where the costs are:

|               | share of turns | share of prose tokens | mean prose tokens/turn |
| ------------- | -------------- | --------------------- | ---------------------- |
| closing turns | 23.6%          | **77.6%**             | 797                    |
| mid-run turns | 76.4%          | 22.4%                 | 71                     |

Three quarters of the prose you pay for is in one turn. We tested position-from-the-end as a
continuous variable, and substituting it for the binary flag was worse. The model flips into
wrap-up mode on exactly one turn.

So here are the measured `p_fire` values :

| turn index | closing turns | mid-run turns |
| ---------- | ------------- | ------------- |
| 0–5        | 78%           | 37%           |
| 5–10       | 100%          | 38%           |
| 10–20      | 79%           | 37%           |
| 20–40      | 66%           | 21%           |
| 40–80      | 42%           | 11%           |
| 80+        | **41%**       | **13%**       |

This is the biggest reason most benchmarks overstate the tool. By turn 80 the mode is firing on
13% of mid-run turns and 41% of closing ones. A benchmark that never runs past turn 20 measures
a regime you spend very little of your bill in.

The instructions don't decay though. caveman's hook injects the full ruleset at every session
start including after compaction, and per-prompt reminders keep arriving no matter how deep
inside the session we are. What decays is the model's own styled output.

Caveman can be turned off. Then the turns sent by the user carry no reminder. Those turns with
no reminder write at a median of **12.00 words per sentence, identical to the sessions that
never ran caveman at all**, against 10.50 when the reminder is present.

## Caveman does compress, just not as much as advertised

Now let's measure `R`, or how much shorter a turn gets when the mode does fire.

We built paired trials: same prompt, both arms, same model, same pinned repository state, arms
isolated so that nothing differs except caveman.

36 headless runs, 18 pairs, one model, of which 9 English pairs were usable for `R`. The result:

| stratum | R        | range         | basis                                |
| ------- | -------- | ------------- | ------------------------------------ |
| closing | **0.83** | IQR 0.73–0.91 | n=9, blended 0.828 at 9/9 compliance |
| mid-run | 0.56     | LOO 0.56–1.76 | **placeholder, not a measurement**   |

**Mid-run `R` is a placeholder and we label it as one everywhere.** Headless agents barely
narrate between tool calls, averaging 2.0 prose tokens on the treated arm and 3.6 on the
control, against 71 in the real corpus.

We did not have enough money to run more arms. n=9 is a fraction of what we planned, and the
values are as-is though not that far from what we've seen on other benchmarks.

## When a token was written matters as much as whether

A token written at turn 3 of a 200-turn session is re-read by every subsequent turn as a cache
read. "Tokens saved × price" is wrong in both directions, and the error scales with session
length.

So we replay the session: change the token count at one position, recompute cache-read
amplification for every later turn, and difference the totals.

This is also where caveman's cost shows up, because of its injections. Measured on the corpora
that ran it, the SessionStart ruleset costs **457 to 467 tokens once per session** and the
per-prompt reminder **34 to 50 tokens on every user turn**. We accounted for those when
estimating the savings (and they're clearly not negligible).

## Costs or savings are indistinguishable

Our corpus is 1,879 sessions, every one of them fully in English, priced at API rates with
everything above wired in.

Take `p_fire` out first, and price every turn as though caveman fired on it. That is the
benchmark number : **+0.757%**.

Now put `p_fire` back. We now drop to **−0.026%** with a sensitivity band of **−0.17% to
+1.44%**. The token-weighted fire rate doing that is 51.8%.

| scenario                      | result     |
| ----------------------------- | ---------- |
| R = 0.35 (caveman benchmarks) | +1.44%     |
| closing 0.73 (IQR low)        | +0.16%     |
| closing 0.83 — shipped        | **−0.03%** |
| closing 0.83 / mid-run 0.12   | +0.14%     |
| closing 0.83 / mid-run 1.20   | −0.17%     |
| closing 0.91 (IQR high)       | −0.16%     |

Caveman is not magical then. On our own sessions it ends up indistinguishable from doing
nothing.

### What it would do to the people who never installed it

These sessions never carried caveman's injections, hence for projections to be valid we
accounted for caveman injections :

| corpus   | bill      | if it always fired   | with `p_fire` wired in |
| -------- | --------- | -------------------- | ---------------------- |
| corpus A | $4626.99  | +$9.36 · +0.20%      | −$6.58 · −0.14%        |
| corpus B | $624.09   | +$3.64 · +0.58%      | −$5.46 · **−0.87%**    |
| corpus C | $131.84   | +$0.34 · +0.26%      | −$0.22 · −0.17%        |
| corpus D | $97.65    | +$0.35 · +0.36%      | −$0.08 · −0.09%        |
| **all**  | **$5481** | **+$13.69 · +0.25%** | **−$12.34 · −0.23%**   |

Four corpora, four sign flips. **Installing caveman would have cost every one of these people
money.**

One caveat we owe you : corpus A is 84% of that bill. Two contributors who were 41% of the money
wrote enough French that no session of theirs survived the filter, and a fifth corpus came
through with two sessions and $1.79, which we dropped as meaningless.

My cofounder and I each have a handful of sessions with caveman switched off, and the projection
on those is negative too : −0.49% and −0.04%.

## The one thing that predicts whether it pays

A corpus average is still useless to you. So we looked for the variable that decides, session by
session, whether caveman wins or loses, across the 1,771 English sessions of the contributors
who never installed it.

The variable you want is **English prose tokens per prompt you send** aka how much English
writing the model does for each thing you ask.

That is arithmetic, not coincidence. Caveman's cost is charged per prompt : 42 tokens of
reminder every time you hit enter (plus the ruleset once of course). Its benefit is a fraction
of the English prose in the answer. So it pays exactly when the answer is long enough to cover
the reminder that asked for it.

| English prose per prompt | share of bill | share that gain | money-weighted |
| ------------------------ | ------------- | --------------- | -------------- |
| 0–200                    | 3.6%          | 0%              | −1.576%        |
| 200–400                  | 30.6%         | 0%              | −0.465%        |
| 400–600                  | 30.4%         | 11%             | −0.115%        |
| 600–800                  | 13.4%         | 21%             | −0.016%        |
| 800–1000                 | 8.0%          | 38%             | −0.004%        |
| 1000–1500                | 10.3%         | 54%             | **+0.063%**    |
| 1500–2500                | 2.8%          | 78%             | **+0.154%**    |
| 2500+                    | 0.9%          | 83%             | **+0.070%**    |

Below a few hundred English prose tokens per prompt, no session gains. Above 1,500, most do. The
crossing is somewhere around a thousand.

## What to actually do with this

If you want to know whether a token-saving tool is worth running, I'd advice to :

**Get your own baseline before you install anything.**

**Randomize.** One session with the tool on, one session without.

**Look at where your bill actually is.** You don't need a prose compressor if 89% of your bill
is in thinking tokens.

**Or just count.** Divide the English prose your model writes by the number of prompts you send.
Well under a thousand tokens, don't bother. Well over, it might pay.

Let's all be suspicious of any single percentage, including ours. The most robust finding in
this whole project is that the answer moves a lot depending on whose _vanilla writing_ you
compare against. Leaving a single contributor out of the control moves the fire rate from 44.1%
to 51.5%, and the contributor who moves it down most holds none of the caveman-live turns at
all.

---

_The measurement code is this repository — the detector, the replay, the pricing, the trial
harness. The transcripts are not and will not be: they're other people's work. Every figure here
can be re-derived against your own sessions; see [REPRODUCING.md](REPRODUCING.md)._

_Thanks to everyone who trusted us with their transcripts. This analysis does not exist without
you, and the most valuable contribution turned out to be from someone who never ran caveman at
all._
