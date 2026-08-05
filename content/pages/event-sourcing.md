# Event Sourcing

State is a cache. Events are the record. Everything else on this page follows from those two sentences.

## The append-only bargain

An event store trades update-in-place convenience for something better: **history you can trust**. Every change is a named fact with a timestamp — `PostRevised`, `OrderPaid`, `StudentEnrolled` — and current state is just a fold over those facts. When someone asks "how did this row get this way?", the answer is a query, not an archaeology project.

## Projections are disposable

Read models exist to be rebuilt. When requirements change, you don't migrate data — you replay the log into a new shape and drop the old one. This site does exactly that on every boot: posts, pages, even its deploy history are projections replayed from event one. Restart the server, and the truth reassembles itself.

## The part nobody warns you about

Events live forever, so they age. Schema evolution — versioning, upcasting, tolerating the event some past version of you wrote three years ago — is where event sourcing becomes a discipline instead of a pattern. Design events as messages to a future stranger.

## When not to use it

CRUD that's truly CRUD should stay CRUD. Event sourcing pays when history, audit, or replay have business value — not as a default. The [colophon](#/page/colophon) shows the smallest honest version of the pattern; the [blog](#blog) will carry the war stories.
