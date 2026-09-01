---
name: priority-guide
description: Write, extend or reverse-engineer a priority guide as markdown, and open it in the priority guide app. Use when someone wants to capture what a screen needs before laying it out — from notes, a transcript, a brief, their own thinking, or by working backwards from an existing prototype or screenshots. Trigger phrases include "priority guide", "PG", "let's priority guide this screen", "turn this into a priority guide", "what does this screen need", "content-first spec for [screen]", "start a priority guide for [product]". Output is always a markdown guides file validated with validate.mjs. Never invents content — an unknown is `??` plus an action item.
---

# priority guide

A priority guide is a **content-first** capture of a screen: an ordered stack of
*what content, data and functionality* it needs, agreed **before** any visual or
layout decision. It is a structured note, not a design. It travels well to
engineering because it says what has to be there and what each thing really is.

This skill writes those guides as markdown. The file is the source of truth; the
app is a render of it.

**It does not make design or product decisions.** Someone supplies the content and
the clarity; this assembles it fast and predictably, and says out loud what is
still unknown.

## The hard rule — never guess

This governs everything below.

- **An unknown is `??` plus an action item.** Never a plausible-sounding
  invention. Business goals are the usual casualty: if nobody has said why the
  business wants this screen to work, write `??` and add
  `ACTION: what is the business goal here?` — do not reason one out.
- **A blank is not `??`.** Blank means the question does not apply to this block.
  `??` means nobody has been asked. Never normalise one into the other.
- **Stop and ask on a blocker**, rather than inventing a way round it: no target
  file or folder, unclear which screen is in scope, material that could describe
  two different screens, a name you cannot resolve.

Asking is cheap. A wrong guess corrupts the artifact, because an invented line
looks exactly like a sourced one and nobody can tell them apart later.

## What you get given

The method is the same however the work starts. Detect the situation; do not make
anyone declare it.

- **From nothing** — notes, a transcript, a brief, or someone thinking out loud.
- **Backwards from a prototype** — an HTML prototype, a Figma file, screenshots.
  Read what is on the screen and record what it *is*, not what it looks like.
- **Extending** — adding to a guide that already exists. Read the whole file first.

## The file

One file holds every guide for a project. `##` is a guide, `###` is a section,
one table row is one content block.

```markdown
# Priority Guides — [Project]

## [Screen name, including the mode]

**User goal:** [what someone is trying to get done here, and how they go about it]
**Business goal:** ??
**Primary users:** [who, with (primary) marked when it differs]
**Notes:** [screen-wide context only — scope, phase, why it exists]
**Sources:** [brief], [interviews]

### [Group of content]

*[Optional clarity — "likely a table", "filters on a left panel"]*

| Content | Real data | Do | Link | Form | Note |
| --- | --- | --- | --- | --- | --- |
| Customer name | First Last | search, sort | | single line | |
| Account number | 4471000123 — 4 to 20 digits | search | | | |
| Status | New, Working, Won, Lost | filter, sort | | single select | |
| Territory | many — likely a select | filter | | single select | |
| [Visual] Coverage map | Counties shaded by rep | | | | ACTION: who owns an unassigned county? |
| Log an attempt | | | modal → [[Log an attempt]] | | |

#### Actions

| Content | Real data | Do | Link | Form | Note |
| --- | --- | --- | --- | --- | --- |
| Export | | | trigger | | Opens a format modal — see [[Export options]] |

> See [[Opportunity Detail]] — the customer fields are specified there.

## Sources

[brief]: https://example.com/wiki/pages/41007 "The brief"
[interviews]: ./research/2026-08-20-synthesis.md "Five interviews, August"
```

Columns are matched **by name, never position**. Reorder them, drop unused ones,
or add your own — a column this format does not know is preserved untouched.

## Filling each column

**Content** — what the thing is called. Use the name the data has, ideally the
one the backend uses. Prefix `[Visual]` for an image, chart, map or anything more
visual than a data point.

**Real data** — the single highest-value column, and the one most often wasted on
a generic description. Put the *actual* data there:
- the real format: `First Last`, `123 N Main St, Clio, MI 48420`
- an explicit example when length varies: `4471000123 — 4 to 20 digits`
- **all the values when there are under about ten**: `New, Working, Won, Lost`
- when there are many, say so and say roughly how many: `many — likely a select,
  40 to 100`

The format, the length and the count are what drive the design decision. Replacing
them with "the customer's address" throws away the only thing this column is for.

**Do** — `search`, `filter`, `sort`, `edit`. Flag the *specific* block that has
the capability, not every block on a screen that has a search box somewhere.

**Link** — where it goes: `download`, `mailto`, `modal`, `offsite page`,
`onsite page`, `trigger`, `upload`, `other`. Write the target as
`modal → [[Log an attempt]]`; a target naming another guide in the file becomes a
route, drawn in the Flow view and back-linked on the target. A control can be a
trigger conceptually and resolve to a modal — say `modal`, and make a guide for it.

**Form** — `date picker`, `single line`, `multi line`, `single select`,
`multi select`, `other`, plus `required`. **Functionality, never a visual
solution.** `single select`, not `dropdown`; the designer decides radio versus
select later. Writing a visual answer here is the most common way one of these
gets ruined.

**Note** — everything else about the row. A rule that has to hold, a link to a
document, something someone said in a session, a follow-up. **A row can carry
several**, separated by `<br>` — which is how a markdown table cell holds more
than one line, and which Obsidian and GitHub both render. A note that is just a
`[handle]` is a cited source.

A note beginning `ACTION:` is an action item: **a follow-up or open question to
circle back on, and nothing else.** Never use it to mark something merely
important — that goes in an ordinary note. The goal is to clear every action item
to zero, which only works if the marker means one thing.


## Sections, and how to group

No hard rules — group by whatever is intuitive for the screen, which is usually
**by the thing it is about**. All the data points for one entity belong together
because they will probably end up as one table. Use a `####` subsection to split
a group, most often "the data someone sees" then "ACTIONS" for the per-row actions.

A priority guide *groups* content. It does not decide the design.

## Sources — attaching a brief, a synthesis, a decision

`## Sources` holds ordinary markdown reference-link definitions. That is
deliberate: they are valid markdown everywhere, so the same file renders live
links in the app, in Obsidian and on GitHub.

Write a document down once, then cite it as `[handle]` from a guide's
`**Sources:**` line, from a section, or from any Note. That is what makes it
scale — twenty rows citing the brief cost twenty characters each, not twenty URLs.

**Cite the source of anything you did not make up.** If a value came from a
research synthesis, cite it. If a rule came from a decision record, cite it. A
reader six weeks later needs to know which lines have something behind them.

## Screens, references, and what counts as one guide

A guide covers any **contained experience** — a full page, a dialog, a modal, a
flyout, a side panel. The form does not matter; the containment does. If it opens
as its own thing, it gets its own guide, and the thing that opens it carries a
route to it.

Use a `> See [[Other guide]] — why` blockquote to avoid repeating content. Keep
one source of truth and reference it everywhere else. A route and a reference are
different things: a route means the user can get there, a reference means the
detail is specified there.

## The shape of a run

1. **Read everything you have been given, in full**, before writing anything.
   If a guides file already exists, read all of it — you are extending, not
   starting over.
2. **Confirm the scope** — which screen or screens, and where the file goes. Ask
   if it is unclear rather than choosing.
3. **Draft** the guide into the file shape above. Mark every unknown `??` plus an
   action item. Cite a source for anything that came from a document.
4. **Validate** — `node validate.mjs "<path>"`. It must print `OK`. Never hand
   over or open a file that failed; fix it and run again.
5. **Read the findings it prints** — dangling routes, handles cited but never
   defined, guides nothing routes to, duplicate names, visual answers where
   functionality belongs. Fix what is a mistake; report what is a real gap.
6. **Open it** — run `priority-guide` (or `./serve.sh`) and say which folder to
   pick, with the absolute path, because the browser's folder picker cannot be
   driven programmatically.
7. **Report** what you drafted, every action item and `??` you left, and anything
   you had to ask about.

## What to say when you are done

- What was created or extended, and where.
- The counts: guides, content blocks, routes, sources.
- **Every open item, listed** — the action items and the unknowns, with the block
  each came from. This is the handover; burying it defeats the exercise.
- Anything you could not source, stated as a question rather than a gap.

## The one thing not to do

Do not fill a guide with confident, plausible content to make it look finished.
A guide with fifteen sourced blocks and six action items is useful. The same guide
with twenty-one blocks and no action items, where six were invented, is worse than
having written nothing — it has laundered guesses into a specification, and the
next person will build them.
