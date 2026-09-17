# Pipelined upload: measurement

This records what the pipelined upload path in `src/commands/asset.ts` was measured to do, on a
local harness, against the serial path it replaces. The short version is at the top because the
result is not the one the change was made in the hope of finding.

## Verdict

**No wall-clock win was measured, in any mix.** Across five scenarios and seven runs each, the
pipelined path came out between 0.8% faster and 7.9% slower by median, and slower in four of five
by minimum. Every one of those differences is inside the run-to-run spread, so the honest reading
is "no difference", not "a small regression" — but there is certainly no speed-up to claim.

The one thing that did improve, reproducibly and well outside the noise, is **time to first
upload**: on a 30,000-file library it fell from 4,573 ms to 1,579 ms (median), and in the quietest
runs from 2,381 ms to 893 ms. That is a real, user-visible change in when the upload progress bar
starts moving. It is not a change in when the command finishes.

Whether that is worth the added complexity — a hand-off queue, a backpressure gate, a size-or-age
batcher, and a lifetime for the progress bars that now spans two phases — is a judgement call. The
numbers are below so the call can be made on them.

The obvious objection to this section is that a loopback stub cannot produce the case the change
was designed for, a client idling on the network while the disk still has hashing to do. That was
measured separately and is reported under "Follow-up: constrained uplink" at the end of this
document. It does not rescue the result: there is no uplink speed at which pipelining wins, and on
a slow link it adds a bulk-upload-check request that the serial path does not send. The conclusion
there is to drop the change.

## Why the ceiling is low

The saving available to any overlap of the two phases is bounded by

    saving <= min(hash_time, upload_time) x (N - BATCH) / N

where `BATCH` is 5,000, the bulk-upload-check batch size. The first 5,000 files cannot overlap
anything: nothing is known to be new until the first check request returns. So a library of 6,000
files has only its last 1,000 files' hashing available to hide, and a library of fewer than 5,000
has none at all unless hashing is slow enough for the idle flush to fire.

Measured hash-and-check time as a fraction of total run time (the `--no-upload` configuration
against the full one) is 8–15% for the mostly-new mixes. Multiply by the overlappable fraction and
the theoretical best case is:

| scenario | hash fraction | overlappable | ceiling | measured |
| --- | --- | --- | --- | --- |
| 30,000 x 8 KiB | 15.4% | 83% | 12.8% | +2.7% |
| 6,000 x 64 KiB | 8.2% | 17% | 1.4% | -0.8% |
| 800 x 1 MiB | 9.4% | 0% | 0% | -0.3% |
| 6,000 x 64 KiB, 90% duplicates | 43% | 17% | 7.3% | +2.9% |
| 6,000 x 64 KiB, all duplicates | n/a | 0% | 0% | +7.9% |

Negative "measured" means faster. Only the first scenario has a ceiling worth chasing, and it did
not come close to it.

## Why the first scenario missed its ceiling

Uploading 30,000 files at concurrency 32 against a server that sleeps 8 ms per upload should take
about 7.5 s of waiting. It takes 21–25 s. The difference is client-side: roughly 0.5 ms of Node
per request, times 30,000 requests, for multipart construction, the `fetch` path, and the event
loop. During the upload phase the CLI is therefore **CPU-saturated, not waiting**.

That is the mechanism by which the change fails to pay: hashing is also CPU-bound, so overlapping
the two phases does not use an idle resource, it makes two CPU-bound workloads contend. The total
work is unchanged and the wall clock reflects that.

This is a property of the workload, not only of the harness. A real instance has the same
per-request client cost. What a real instance adds is server and network latency large enough that
concurrency hides the client cost — and in that regime the upload phase is long, so the hash
fraction is *smaller* still and the ceiling *lower*, not higher.

## What the harness cannot model

A loopback stub cannot reproduce the regime the change was designed for: a slow uplink where the
client sits idle waiting on the network while the disk is free to hash. Here, "uploading" means
streaming to `127.0.0.1`, which costs the same cores the hasher needs. No figure in this section
should be read as covering that case — it is measured in the follow-up below, with a bandwidth
limit added to the stub, and the answer turns out to be the same one.

Nor can it model large media files honestly. The corpora live on tmpfs to keep generation from
dominating the run, which caps the total size well below a real photo library and removes real
disk seek cost from hashing entirely.

## Method

- `bench/stub-server.mjs` — an HTTP stand-in for the Immich API, complete enough for
  `immich upload`: `/users/me`, `/api-keys/me`, `/server/media-types`, `/assets/bulk-upload-check`,
  `/assets`. Per-upload and per-check latency, and the fraction of files it calls duplicates, are
  set by environment variable. It records upload and check counts, the size of each check batch,
  and the time of the first and last upload, and serves them from `/__stats`.
- `bench/pipeline-bench.mjs` — runs three configurations per scenario against that stub:
  - `hashOnly`: the pre-change bundle with `--no-upload`. The hash-and-check phase alone, and so
    the upper bound on what overlapping can ever save.
  - `serial`: the pre-change bundle.
  - `pipelined`: the post-change bundle.
- Both bundles are built `dist/index.js` files: `serial` from `4f2dc1d79`, `pipelined` from this
  branch.
- One corpus per scenario, generated once and reused by every run. Regenerating large trees
  between runs was itself the largest source of variance.
- A fresh `XDG_CACHE_HOME` per run, so no warm hash cache leaks between them.
- Configurations are interleaved and **rotated** per attempt, so none of the three always occupies
  the same slot. Running all of one configuration before all of another let background load drift
  show up as a difference between configurations; an earlier run of this harness reported the same
  scenario as -0.5% and then +36.6% for exactly that reason.
- `RUNS=7`. Reported as median and minimum. On a shared machine the minimum is the run least
  polluted by contention and is the fairer comparison; the median is reported alongside it because
  a single fast run is not evidence on its own.

Reproduce with:

```
pnpm --filter @immich/cli build          # produces dist/index.js for the current tree
RUNS=7 node bench/pipeline-bench.mjs <serial-bundle> <pipelined-bundle>
```

Host: 8 cores, 15 GiB RAM, `/tmp` a 7.6 G tmpfs, load average 0.32 at the start of the run. The
machine was running other work; see the note on minimums above.

## Raw timings

All figures in milliseconds, seven runs per configuration, in the order they were taken.

### mostly-new, 30,000 x 8 KiB, upload 8 ms, concurrency 32

```
hashOnly   3585, 4906, 4606, 2025, 2077, 3845, 3105     median 3585   min 2025
serial    25198, 25659, 24450, 21027, 17483, 22804, 23235   median 23235  min 17483
pipelined 25559, 29351, 32664, 21224, 23668, 21212, 23867   median 23867  min 21212
```

Change: **+2.7% by median, +21.3% by minimum.** Check batches `[5000 x 6]` in both — the batching
policy is unchanged, as required. Time to first upload: serial median 4,573 ms, pipelined median
1,579 ms; best runs 2,381 ms and 893 ms.

### mostly-new, 6,000 x 64 KiB, upload 8 ms, concurrency 8

```
hashOnly    980, 856, 866, 822, 1002, 882, 1019          median 882    min 822
serial    10799, 10800, 10475, 10666, 11068, 11764, 11892   median 10800  min 10475
pipelined 11390, 10577, 10564, 11135, 10713, 10644, 11497   median 10713  min 10564
```

Change: **-0.8% by median, +0.8% by minimum.** Batches `[5000, 1000]`. Time to first upload:
1,080 ms serial, 808 ms pipelined (medians).

### mostly-new, 800 x 1 MiB, upload 30 ms, concurrency 4

```
hashOnly    782, 863, 902, 814, 856, 861, 964            median 861    min 782
serial     8863, 8972, 9148, 9056, 9111, 9206, 9404      median 9111   min 8863
pipelined  9110, 8961, 9002, 9080, 9088, 9106, 9223      median 9088   min 8961
```

Change: **-0.3% by median, +1.1% by minimum.** A single check batch of 800, hashed faster than the
idle interval, so nothing flushes early and no overlap is structurally possible. Included to show
that case honestly rather than omit it.

### mostly-duplicates (90%), 6,000 x 64 KiB, upload 8 ms, concurrency 8

```
hashOnly    984, 909, 952, 937, 1041, 923, 1011          median 952    min 909
serial     2523, 2203, 2276, 2227, 2157, 2110, 2216      median 2216   min 2110
pipelined  2280, 2411, 2136, 2280, 2336, 2355, 1966      median 2280   min 1966
```

Change: **+2.9% by median, -6.8% by minimum.** The two statistics disagree in sign, which is the
clearest single indication that the effect is below the noise floor. 600 of 6,000 files uploaded.

### all-duplicates, 6,000 x 64 KiB, concurrency 8

```
hashOnly    987, 923, 971, 904, 1024, 929, 994           median 971    min 904
serial      856, 951, 1065, 878, 1038, 917, 1108         median 951    min 856
pipelined   909, 1043, 1026, 914, 875, 1062, 1026        median 1026   min 875
```

Change: **+7.9% by median, +2.2% by minimum.** Nothing is uploaded, so there is nothing to
pipeline; the run is hash-and-check only and the whole spread is noise on a sub-second total. The
percentage is large only because the denominator is small.

## What was verified rather than measured

These are covered by tests in `src/commands/asset.spec.ts` rather than by timings:

- Steady state still sends full 5,000-entry batches; the idle flush fires only for the tail or a
  slow producer. Asserted against a fast producer.
- The hand-off queue is bounded at `concurrency x 4` in flight, and hashing is held back when it
  is full.
- A file whose upload fails after its retries is not counted as uploaded and is not deleted.
- Deletion still runs only after every upload has settled.
- `--no-upload`, `--dry-run` and `--json-output` behave as before.

---

# Follow-up: constrained uplink

The measurement above was made against a loopback stub, where "uploading" costs local CPU rather
than network time. That could not produce the regime the change was designed for — a client idling
on the network while the disk still has hashing to do — so the obvious objection was that the
experiment had never given the change a chance. This section closes that.

## Question

Is there any realistic uplink speed at which pipelining measurably beats serial, and if so, where
is the crossover?

## Answer

**No, and there is no crossover.** At 100, 20 and 5 Mbit/s, in both mixes, the difference stays
inside the run-to-run spread. It does not improve as the link gets slower; it converges on zero.
The most link-bound point measured — 5 Mbit/s, mostly-new — came out at +0.1% by median and -0.4%
by minimum.

In four of the six scenarios the median and the minimum disagree about the *sign* of the change.
That is the signature of no effect, not of a small one.

## How the uplink is simulated

`bench/stub-server.mjs` takes `STUB_UPLINK_BPS`. The stub reads each request body over loopback as
before, then charges its full byte count to a **shared** reservation of the simulated link, and
responds only when those bytes would have finished arriving. Two properties matter:

- The link is one pipe that all connections queue behind, so raising `--concurrency` cannot make it
  carry more, exactly as with a real uplink.
- By the time the charge is applied the body has already been received, so the client is genuinely
  idle waiting on the response. That is the condition the change is meant to exploit.

Bulk-upload-check requests are charged to the link too. They are not free on a slow connection and
a real client would pay for them.

File sizes are chosen per bandwidth to keep the upload phase near 35–45 s; 5 Mbit/s of real
photographs would run for days. Every scenario uses 30,000 files so that five of the six check
batches have somewhere to overlap into — 83% of the hashing is structurally overlappable, which is
the most favourable framing available. Hashing cost is near enough constant across the three
bandwidths, so if overlap cannot pay here it cannot pay at these speeds at all.

Methodology is otherwise unchanged: 7 runs per configuration, rotated order, a fresh cache per run,
one corpus per scenario. Reproduce with:

```
SCENARIO_SET=throttled RUNS=7 node bench/pipeline-bench.mjs <serial-bundle> <pipelined-bundle>
```

## Results

Negative means pipelined is faster. `hash` is the `--no-upload` median, that is, the ceiling on what
overlap could ever hide. All figures are medians of seven runs, in milliseconds.

| uplink | mix | hash | serial | pipelined | by median | by min |
| --- | --- | --- | --- | --- | --- | --- |
| 100 Mbit/s | mostly-new | 3,411 | 37,085 | 40,154 | +8.3% | -6.6% |
| 20 Mbit/s | mostly-new | 3,099 | 39,718 | 41,172 | +3.7% | -3.8% |
| 5 Mbit/s | mostly-new | 7,040 | 43,426 | 43,449 | +0.1% | -0.4% |
| 100 Mbit/s | 90% duplicates | 3,460 | 7,143 | 6,874 | -3.8% | -7.6% |
| 20 Mbit/s | 90% duplicates | 3,423 | 7,220 | 7,672 | +6.3% | +9.5% |
| 5 Mbit/s | 90% duplicates | 7,153 | 11,004 | 11,125 | +1.1% | +0.8% |

Spreads, as minimum to maximum over the seven runs:

```
100 Mbit/s, mostly-new, 30000 x 9 KiB
  hashOnly   2054-4163     median 3411    min 2054
  serial    34761-39933    median 37085   min 34761
  pipelined 32479-42202    median 40154   min 32479

20 Mbit/s, mostly-new, 30000 x 1400 B
  hashOnly   2299-4776     median 3099    min 2299
  serial    36229-43779    median 39718   min 36229
  pipelined 34866-43990    median 41172   min 34866

5 Mbit/s, mostly-new, 30000 x 64 B
  hashOnly   7031-7586     median 7040    min 7031
  serial    42679-45341    median 43426   min 42679
  pipelined 42529-44846    median 43449   min 42529

100 Mbit/s, 90% duplicates, 30000 x 9 KiB
  hashOnly   3288-3709     median 3460    min 3288
  serial     6591-7627     median 7143    min 6591
  pipelined  6089-7219     median 6874    min 6089

20 Mbit/s, 90% duplicates, 30000 x 1400 B
  hashOnly   3002-3810     median 3423    min 3002
  serial     6417-7892     median 7220    min 6417
  pipelined  7024-7917     median 7672    min 7024

5 Mbit/s, 90% duplicates, 30000 x 64 B
  hashOnly   7037-7297     median 7153    min 7037
  serial    10697-11227    median 11004   min 10697
  pipelined 10779-11633    median 11125   min 10779
```

## Why it does not pay, even with the client idle on the network

The stub reports how many bytes it accepted, so the throughput each run actually achieved can be
compared against the link's capacity. It is the same either way, in MB/s across the seven runs:

| scenario | capacity | serial achieved | pipelined achieved |
| --- | --- | --- | --- |
| 5 Mbit/s, mostly-new | 0.625 | 0.53–0.57 | 0.54–0.57 |
| 20 Mbit/s, mostly-new | 2.5 | 1.47–1.77 | 1.46–1.84 |
| 100 Mbit/s, mostly-new | 12.5 | 7.48–8.59 | 7.08–9.20 |

Both configurations leave the link idle — badly so at 20 and 100 Mbit/s — and **pipelining recovers
none of it**. If the client were blocked on the network while the disk sat free, the overlap would
show up here as the pipelined run driving the link harder. It does not.

The idle link is not caused by the phase ordering. It is caused by the client's per-request cost:
roughly 0.5 ms of Node per upload for multipart construction, the `fetch` path and the event loop,
times 30,000 files. That work is on the critical path whether or not hashing is happening at the
same time, and hashing needs the same core. Overlapping two workloads that contend for one resource
does not create capacity.

So the earlier loopback result was not an artefact of loopback. It was this, showing up somewhere it
was easy to mistake for one. The saving the design aimed at exists only if hashing uses a resource
the upload leaves idle, and in this client they use the same one.

## A cost the pipelined path adds

At 5 Mbit/s the pipelined path sent **seven bulk-upload-check requests where serial sent six**,
reproducibly in seven runs of seven, in both mixes:

```
serial     [5000, 5000, 5000, 5000, 5000, 5000]
pipelined  [5000, 5000, 5000, 4838, 5000, 5000,  162]
pipelined  [5000, 5000, 5000, 2417, 5000, 5000, 2583]   (90% duplicates)
```

The cause is an interaction between the two new mechanisms. On a slow link the upload queue stays
saturated, so the backpressure gate holds the hashing workers for longer than the batcher's 1,000 ms
idle interval. The idle flush then fires mid-stream and sends a partial batch — precisely what that
flush exists to avoid anywhere but the tail.

It is a mild breach of the "do not multiply check requests" constraint: one extra request in six,
not a per-file storm. It is invisible on a fast link, where hashing is never held that long. It is
recorded here because it is a cost the change introduces in exactly the regime it was meant to help,
and it would need fixing — a longer idle interval, or suppressing the idle flush while the gate is
holding — before the branch could be merged.

## Conclusion

Across nine scenarios and two resource regimes, pipelining the upload never measurably beat the
serial path. It has no crossover speed, it does not fill an idle uplink, and on a slow link it sends
a check request the serial path does not. The only reproducible benefit remains the earlier start of
the progress bar.

On these numbers the change does not earn the hand-off queue, the backpressure gate, the batcher and
the shared progress-bar lifetime that it costs. The recommendation is to drop it.
