# The thing you can only know by staying

I run `ps -ef` looking for something unrelated. The laptop fan is doing something it shouldn't.

42 lines come back. All the same:

```
bun /Users/zero8/zero8.dev/smriti/src/index.ts ingest claude
```

The oldest one started Wednesday. It is Sunday.

That's the moment. The moment where you realise you've been here for a while. Long enough to have written a hook script that is now eating 9 CPU-days of your laptop's life. Long enough that the script is older than your memory of writing it. Long enough that the conditions you wrote it under — three Claude sessions at most, a DB that fit in a megabyte, an ingest that returned in two seconds — are all gone, replaced by their grown-up versions you didn't notice arriving.

## How sensible decisions accumulate

Every line of that hook was sensible the day I wrote it.

The hook was one line. There was no reason to add a lock — I had one Claude session at a time, and the ingest was fast, and locking adds complexity for a problem I didn't have. The "right" code that day was the simplest code that worked.

`smriti ingest claude` was sensible too. It was a script that scanned the Claude logs directory and put new content into a SQLite DB. The directory had ten files. The DB was empty. The scan took milliseconds. There was nothing to optimise.

And the decision to fire on every Stop event — that was the whole pitch. *Memory that's always fresh.* Asking the user to remember to ingest defeats the entire thing. Automate it. Tie it to the natural rhythm of working.

Each of those decisions was correct in isolation, given the world at the time it was made. None of them were wrong. They just turned out to compose into something that was wrong, given the world four months later.

## You can read about this. You can't know it.

I have read pieces about hooks. About background work. About the difference between fire-and-forget and request/response. I have probably written some. I *knew*, in the way you know things when you've read them, that long-running operations on event triggers need backpressure.

But I didn't feel it, the way you feel something after you've seen it eat your laptop, until I saw it eat my laptop.

This is the part I want to write down, because I think it's the underrated thing about staying with one project for a long time. The lessons available to you change shape. At the start, the lessons are mostly external — you read someone else's blog, you copy the pattern, you avoid the trap they fell in. After a while, the lessons are mostly yours — you trip over things that were perfectly fine when you wrote them and have become broken without anyone touching them.

## What time does

What time does is this: it inverts which assumptions are load-bearing.

When I started Smriti, the load-bearing assumption was "a session is one conversation in one window." The whole architecture flowed from that. As I lived with the tool, I started running three sessions, then five, then ten. Each session was sensible. Concurrency snuck in without anyone introducing it.

When I started Smriti, the DB was small and the embedding pipeline was a plan. As I lived with the tool, both grew. The ingest that used to return in two seconds returned in two minutes. The 30-second async timeout in the hook config was a generous upper bound; then it was a tight bound; then it was meaningless.

Nothing changed. Everything changed.

## Living downstream

The project doesn't tell you when its assumptions are being violated. It just gets slower and weirder, and you blame the laptop, or the day, or the model, until one day you run `ps -ef` and find your evidence.

The people who can read this kind of evidence are not the people who studied software architecture the hardest. They're the people who stayed with one thing long enough to watch it drift away from the conditions it was written under, and to recognise the shape of that drift when it shows up somewhere else. A lot of what we call "experience" is this. Not knowing more patterns. Knowing how patterns rot.

There's a second-order version of this, too. When I went and read QMD — the library Smriti is built on — I realised it doesn't have any of this machinery. No file watching, no debouncing, no daemon for ingest. QMD assumes the user runs `qmd update` when they want to update. The author of QMD, whoever they were the day they wrote it, decided "automatic ingest" was someone else's problem. I am now someone else. I added the automatic ingest. I now have the problem.

That's not a critique of QMD. It's an observation about the seam where one project ends and another begins. Every "we'll just wrap this and add a little convenience" is also "we'll just inherit whatever problems this convenience creates." You can only see those problems by living downstream of the seam long enough for them to show up. The original authors couldn't have warned you. They couldn't see them either, because they hadn't stayed in your version of the world.

## The trade

The fix was six characters: `lockf -t 0`. The follow-up — a real daemon, FS watching, debouncing — is more involved but well-understood by now. I filed the issue. Someone (probably me) will pick it up.

What's harder to write down is the part that happens to you while you're fixing it. The recognition that your old code is no longer your code, exactly. It belongs to a version of the project and a version of you that don't exist anymore. The new versions inherit it without remembering writing it.

The thing that didn't exist on day one isn't the bug. The bug is just a consequence. The thing that didn't exist on day one is *the conditions under which the original code was wrong*. Those took months to arrive, quietly, while I was paying attention to other things.

People say "this project teaches you something every day" and mean it as a compliment to the project. I think it's also a fact about time. You're not really learning *the project*. You're learning what the project becomes, slowly, without anyone making it become anything.

The 42 processes are gone now. One command killed them all. But the version of me that wrote that hook didn't get to learn anything from them — only the version of me that found them did. That's the trade. You can't read your way to it. You have to stay.
