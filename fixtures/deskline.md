# Priority Guides — Deskline

Deskline is a workplace booking tool: desks, meeting rooms and parking bays.
These guides capture what each screen needs before anything is laid out.

- `??` means nobody has been asked yet. A blank means the question does not apply.
- A note beginning `ACTION:` is a follow-up to circle back on. The goal is zero.
- `[[Another guide]]` in the Link column is a route the user can take.
- `[handle]` cites a source defined at the bottom of the file.

---

## Bookings — My Week

**User goal:** See what I have booked this week and fix anything that is wrong, without opening each booking.
**Business goal:** Cut the no-show rate on desks, which is what drives the floor-space bill.
**Primary users:** Everyone with a desk (primary) · Office manager
**Notes:** The week view is the landing screen. A day view was asked for and deferred.
**Sources:** [brief], [interviews]

### The week

*Likely a table, one row per booking. Seven day columns were rejected in review — see [interviews].*

| Content | Real data | Do | Link | Form | Note |
| --- | --- | --- | --- | --- | --- |
| Date | Mon 8 Sep | filter, sort |  |  |  |
| Space | Desk 4-118, Room "Ash", Bay 12 | search, sort |  |  | Three space types share this column — [naming] |
| Building | Riverside, Northgate, Depot | filter |  | single select |  |
| Time | 09:00–17:30, or All day | sort |  |  |  |
| Status | Booked, Checked in, No-show, Cancelled | filter, sort |  |  | No-show is set by the door reader, never by a person<br>Cancelled bookings stay on the list for the rest of the day |
| Who it is for | First Last — blank when it is your own | search |  |  | Only office managers see bookings that are not theirs |
| Open the booking |  |  | onsite page → [[Booking detail]] |  |  |
| Cancel |  |  | modal → [[Cancel a booking]] |  |  |
| Export the week |  |  | download |  | ACTION: which formats does Finance actually need? |

#### Empty and error states

| Content | Real data | Do | Link | Form | Note |
| --- | --- | --- | --- | --- | --- |
| Nothing booked this week | "No bookings. Book a desk →" |  | onsite page → [[Find a space]] |  |  |
| [Visual] Building closed | Shown when the whole building is shut that day | ?? |  |  | ACTION: does a closure cancel bookings, or just warn? Ask facilities |

### Booking a new space from here

*The primary action. It opens the finder rather than a form, because people pick a place before a time.*

| Content | Real data | Do | Link | Form | Note |
| --- | --- | --- | --- | --- | --- |
| Book a space |  |  | onsite page → [[Find a space]] |  |  |
| Repeat last week |  |  | trigger |  | Recreates every booking from the previous week — [interviews] |

> See [[Booking detail]] — the full field list for a booking is specified there.

## Booking detail

**User goal:** Check or change one booking, and know whether it still holds.
**Business goal:** ??
**Primary users:** Everyone with a desk (primary) · Office manager
**Sources:** [brief]

### The booking

| Content | Real data | Do | Link | Form | Note |
| --- | --- | --- | --- | --- | --- |
| Reference | DL-8841-2 — always 4 digits then a checksum digit | search |  |  | Never reused, even after a cancellation<br>[refs] |
| Space | Desk 4-118 |  | onsite page → [[Space detail]] |  |  |
| Date | Mon 8 Sep 2026 | edit |  | date picker, required |  |
| Time | 09:00–17:30, or All day | edit |  | single select, required | Half-day options were cut in review |
| Who it is for | First Last | edit |  | single select | Office managers only<br>[privacy] |
| Notes for the desk host | Up to 200 characters. Usually blank. | edit |  | multi line |  |
| Status | Booked, Checked in, No-show, Cancelled |  |  |  |  |
| Check in |  |  | trigger |  | Only inside a 30-minute window either side of the start<br>ACTION: what happens if someone checks in late? |
| Cancel |  |  | modal → [[Cancel a booking]] |  | [policy] |

### Who else is in

*The reason people gave for opening this screen at all.*

| Content | Real data | Do | Link | Form | Note |
| --- | --- | --- | --- | --- | --- |
| People on this floor that day | 14 booked, 9 checked in |  |  |  | Counts only, no names, by policy — [privacy] |
| [Visual] Floor plan thumbnail | The floor with booked desks shaded |  | modal → [[Floor plan]] |  |  |

> See [[Cancel a booking]] — the cancellation rules live there, not here.

## Cancel a booking

**Type:** Screen
**User goal:** Give up a space I am not going to use, and know it is really gone.
**Business goal:** Every cancellation more than two hours out is a desk somebody else can have.
**Primary users:** Everyone with a desk
**Notes:** A modal, opened from the week view and from the booking. Not its own page.

### Confirming

| Content | Real data | Do | Link | Form | Note |
| --- | --- | --- | --- | --- | --- |
| What is being cancelled | Desk 4-118, Mon 8 Sep, 09:00–17:30 |  |  |  |  |
| Reason | Not needed, Working from home, Sick, Meeting moved, Other | edit |  | single select | Five values, so they can all be shown |
| Reason, in words | Only when Other is picked | edit |  | multi line |  |
| Late-cancellation warning | Shown under two hours: "This counts as a no-show." |  |  |  | ACTION: confirm the two-hour rule with facilities — [policy] |
| Cancel the booking |  |  | trigger |  |  |
| Keep it |  |  | trigger |  |  |

## Find a space

**User goal:** Find somewhere to sit or meet on a given day, and book it in one go.
**Business goal:** Fill the desks that are furthest from the door, which are the ones that go empty.
**Primary users:** Everyone with a desk (primary) · Visitor host
**Sources:** [brief], [naming]

### What I am looking for

*Filters. They sit above the results, not beside them, because most people set one and stop.*

| Content | Real data | Do | Link | Form | Note |
| --- | --- | --- | --- | --- | --- |
| Day | A single date. Defaults to the next working day. | edit |  | date picker, required |  |
| Building | Riverside, Northgate, Depot | filter, edit |  | single select |  |
| Floor | many — likely a select, 3 to 19 per building | filter, edit |  | single select |  |
| What kind of space | Desk, Meeting room, Parking bay | filter, edit |  | single select, required |  |
| Needs | Second screen, Standing, Step-free, Near a window | filter, edit |  | multi select | Four today. Facilities want to add their own — [naming] |
| How many people | 1 to 24 | edit |  | single line | Meeting rooms only |

### What is free

| Content | Real data | Do | Link | Form | Note |
| --- | --- | --- | --- | --- | --- |
| Space | Desk 4-118, Room "Ash" | sort |  |  |  |
| Where it is | Riverside, floor 4, north side |  |  |  |  |
| What it has | Second screen, Standing |  |  |  |  |
| Distance from the entrance | 40m — used to sort, shown as Near/Middle/Far | sort |  |  | ACTION: is Near/Middle/Far clear enough, or do people want the metres? |
| [Visual] Where it is on the floor | The floor plan with this space marked |  | modal → [[Floor plan]] |  |  |
| Book it |  |  | trigger |  | Books immediately. No confirmation step — [interviews] |

### Sources

[naming]: https://example.com/wiki/spaces/DL/pages/44120 "Space naming and needs taxonomy"

## Floor plan

**User goal:** Understand where a space actually is before committing to it.
**Business goal:** ??
**Primary users:** Everyone with a desk (primary) · Visitor host
**Notes:** Opened as a modal from two places. Never a page of its own.

### The plan

| Content | Real data | Do | Link | Form | Note |
| --- | --- | --- | --- | --- | --- |
| [Visual] The floor | Booked desks shaded, free desks outlined, the selected one filled |  |  |  |  |
| Building and floor | Riverside, floor 4 | edit |  | single select |  |
| Day | Mon 8 Sep 2026 | edit |  | date picker |  |
| A space on the plan | Desk 4-118 — free | search |  |  | Hovering shows the name and whether it is free |
| Book this one |  |  | trigger |  |  |
| [Visual] Legend | Free, Booked, Yours, Out of service |  |  |  | ACTION: "Out of service" has no data behind it yet — [policy] |

## Space detail

**User goal:** Know what a space is and whether it is worth booking again.
**Business goal:** ??
**Primary users:** Office manager (primary) · Everyone with a desk
**Notes:** Reached from a booking. Nothing routes here from the finder yet.

### The space

| Content | Real data | Do | Link | Form | Note |
| --- | --- | --- | --- | --- | --- |
| Name | Desk 4-118, Room "Ash" |  |  |  | Rooms are named, desks are numbered — [naming] |
| Where it is | Riverside, floor 4, north side |  |  |  |  |
| What it has | Second screen, Standing, Step-free |  |  |  |  |
| Out of service | ?? |  |  |  | ACTION: who marks a space out of service, and does it cancel bookings? |
| [Visual] Photo | One photo, taken by facilities. Often missing. |  |  |  |  |
| Report a problem |  |  | mailto |  | Goes to the building inbox, not a ticket queue |

## Sources

[brief]: https://example.com/wiki/spaces/DL/pages/41007 "Deskline brief — what we are building and why"
[interviews]: ./research/2026-08-20-booking-interviews-synthesis.md "Nine people, three buildings, August 2026"
[privacy]: https://example.com/wiki/spaces/DL/pages/43880 "What we show about other people"
[policy]: ./decisions.md#late-cancellation "Late cancellation — decided 2026-08-14"
[refs]: <./research/Booking reference format.md> "Why references are 4 digits plus a checksum"
