# Frontline World Ltd

Public website for Frontline World Ltd. It is a static site built with [Hugo](https://gohugo.io) and published to GitHub Pages.

## What this project is

The site uses plain Hugo: no theme, no package manager, and no build step other than the `hugo` command.

- **Every page is one complete HTML file** in `content/`.
- **`layouts/` holds the passthrough templates, plus the partials and shortcodes that build the generated parts**: the insights lists, the associate directory, and the associate profiles.
- **`data/` holds the records that pages are built from**: associates, assignment teams, and the vocabulary those records refer to. It also holds `data/private/`, which the site never serves.
- **`static/` holds the CSS, JavaScript, and images.**
- **`hugo.toml` holds site configuration.**
- Pushing to `main` rebuilds and deploys the site through GitHub Actions.

## Content and layout live together

This site does not split content and presentation. Each page is a single HTML file that already contains its own `<head>`, navigation, page content, and footer. Hugo renders the file as it is.

To change a page, edit its file in `content/`. There is no separate template to keep in sync. This is the main rule for working in this repository: **the page file is the source of truth.**

## Project structure

```
.
├── content/                       # Every hand-written page: a complete HTML file
│   ├── _index.html                # Home
│   ├── <page>.html                # Top-level pages (about, services, ...)
│   ├── insights/
│   │   ├── _index.html            # Insights listing
│   │   └── <article>.html         # Articles
│   ├── courses/
│   │   └── <course>.html            # Courses (served under /training-academy/)
│   └── people/
│       └── _content.gotmpl        # Generates one profile page per public associate
├── data/                          # Records that pages are built from
│   ├── associates/<id>.yml        # One person: the directory and their profile
│   ├── assignments/<slug>.yml     # The people on one course, programme or project
│   ├── programmes/<slug>.yml      # One learning pathway; the slug is its identifier
│   ├── private/                   # Never served: applications and their uploads
│   │   ├── applications/<id>.yml  # One application, plus the review history
│   │   └── uploads/               # Photographs and CVs sent with an application
│   └── vocab/associates.yml       # The wording behind every expertise, role, sector, region, programme family
├── layouts/                       # Passthrough templates, partials and shortcodes
│   ├── index.html                 # Home
│   ├── _default/single.html       # Regular pages
│   ├── insights/list.html         # Insights listing
│   ├── people/single.html         # Associate profile
│   ├── partials/                  # Shared pieces, including the directory and profile helpers
│   ├── shortcodes/                # Assignment teams, leadership block, associate directory, form options
├── applications-worker/            # Public form endpoint. Validates, then writes to a private R2 bucket
├── review-worker/                  # The reviewer dashboard. Reads R2, writes records to GitHub
├── static/                        # Copied unchanged into the built site
│   ├── styles.css                 # All site CSS, with design tokens at the top
│   ├── script.js                  # Site JavaScript, including the directory filters
│   ├── admin/config.yml           # Decap CMS collections
│   └── images/                    # Images referenced by pages
├── hugo.toml                      # Site configuration
├── public/                        # Generated output (git-ignored, do not edit)
└── .github/workflows/hugo.yml     # Build and deploy to GitHub Pages
```

## How a page works

A content file maps to a URL from its path and name:

| File                                                | URL                 |
| --------------------------------------------------- | ------------------- |
| `content/_index.html`                               | `/`                 |
| `content/<name>.html`                               | `/<name>/`          |
| `content/insights/_index.html`                      | `/insights/`        |
| `content/insights/<slug>.html`                      | `/insights/<slug>/` |
| `content/courses/<slug>.html` with a `url` field | the `url` value       |

Each file starts with a YAML frontmatter block, then a full HTML document. Hugo has one passthrough template per page kind, and each is a single line: `{{ .Content }}`. That outputs the HTML file unchanged.

Hugo blocks HTML content by default. `hugo.toml` re-enables it:

```toml
[security]
  allowContent = ['^text/html$']
```

Do not remove that setting, or the build fails.

## Frontmatter

| Field     | Purpose                                                                                        |
| --------- | ---------------------------------------------------------------------------------------------- |
| `title`   | Page name for reference. It is not rendered, because the `<title>` tag is already in the file. |
| `url`     | Overrides the output path. Courses use it to sit under `/training-academy/courses/`.       |
| `aliases` | Old URLs that redirect to this page.                                                           |

Example:

```yaml
---
title: "My Page"
aliases: ["/news/my-page/"]
---
```

Only `url` and `aliases` change the build. `title` is documentation.

## Links and asset paths

All internal links and asset paths are **relative**, so the site works at the repository subpath and at a custom domain without changes.

A relative path counts how far the page sits below the site root. On a page with one URL segment, reach the root with `../`; with two segments, use `../../`, and so on.

| Page URL                               | Home        | Another page              | Asset                |
| -------------------------------------- | ----------- | ------------------------- | -------------------- |
| `/`                                    | `./`        | `about/`                  | `{{< stylesheet >}}` |
| `/about/`                              | `../`       | `../services/`            | `{{< stylesheet >}}` |
| `/insights/welcome/`                   | `../../`    | `../../about/`            | `{{< stylesheet >}}` |
| `/training-academy/courses/<slug>/` | `../../../` | `../../training-academy/` | `{{< stylesheet >}}` |

Other assets stay relative and follow the depth table: `../images/foo.jpg` from a page one segment deep.

Rules:

- Never start a link or asset path with `/Frontline-World-LTD/`. That hard-codes the deployment path and breaks a custom domain.
- Link the stylesheet with `{{< stylesheet >}}`, never with a hand-written path. That shortcode carries a version built from the stylesheet's own content, so a CSS change reaches browsers instead of being served from a four-hour cache alongside newer markup. See `layouts/partials/stylesheet.html`.
- To link to a section on another page, add the fragment: `../services/#strategic-research`.
- To link to a section on the same page, use just the fragment: `#courses`.

## Shared pieces are repeated on every page

The document head, navigation, and footer appear in full in every hand-written page file. That keeps each page self-contained, at the cost of repetition.

When you change the navigation or footer, change it in every file under `content/`. Use search and replace, and check the result.

The generated parts of the site do share their chrome, because they are built by a template rather than written out: `layouts/people/single.html` and `layouts/insights/list.html` call the same `site-head`, `site-nav` and `site-footer` partials. A change to a partial therefore reaches those pages, and the repeated markup in `content/` still needs editing by hand.

The stylesheet link is the one exception to the repetition. `layouts/partials/stylesheet.html` holds it, `site-head.html` calls it, and the hand-written pages reach it through the `{{< stylesheet >}}` shortcode. Those pages cannot call a partial or evaluate Go template actions, so the shortcode is what lets them share the same version without copying it seventeen times.

## The Associate Directory

People are stored once, as a record per person in `data/associates/`, and every page that mentions a person reads that record. Writing a person into a page is what this section exists to prevent.

One record produces:

- a card in the directory on `/our-people/`
- the options in the Expertise, Role, Sector and Region filters
- a profile page at `/people/<id>/`
- an entry on any course, programme or project that names the person's ID

### The ID is the file name

`data/associates/<id>.yml` is named after the person's ID, and that ID is the profile URL (`/people/<id>/`) and the value an assignment uses to reference them. Renaming a file breaks both, so change the record, not the name.

### What a record holds

| Field           | Purpose                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------ |
| `name`          | Full name as published.                                                                      |
| `title`         | Professional title.                                                                         |
| `organisation`  | Organisation or affiliation.                                                                 |
| `photo`         | File in `static/images`; the folder prefix is ignored, so the CMS may store either form.     |
| `photo_alt`     | Alt text for the photo.                                                                      |
| `summary`       | One or two sentences: the card text and the profile page description.                        |
| `bio`           | Biography, one list item per paragraph. The profile page shows them all.                     |
| `expertise`     | IDs from the expertise list. The first is the card's headline expertise.                     |
| `roles`         | IDs from the roles list: what the person contributes generally.                              |
| `contributions` | IDs from the areas of contribution list.                                                     |
| `sectors`       | IDs from the sectors list.                                                                   |
| `regions`       | IDs from the regions list.                                                                   |
| `countries`     | Countries or regions of specific expertise, one per list item. Free text. Optional.         |
| `qualifications`| Qualifications, one per list item. Optional.                                                 |
| `experience`    | Selected experience, one entry per list item. Optional.                                      |
| `teaching_subjects` | Subjects the person can teach or deliver, one per list item. Optional.                   |
| `languages`     | Languages and proficiency, one per list item. Optional.                                      |
| `links`         | Professional links, each a `label` and a `url`.                                             |
| `visibility`    | `public`, or `private` to keep the person off the site.                                      |
| `profile_status`| `active`, or `inactive` or `archived` to keep the person off the site without discarding the record. |
| `leadership`    | `true` puts the person in the leadership block instead of the directory grid.                |
| `weight`        | Order in the directory; lower comes first.                                                  |

Every field in a record is published, so keep administrative notes out of it. The record is split from the administrative material: a person's contact details, availability, uploaded files, consent answers and review history live in `data/private/applications/<id>.yml`, which no template reads. See "Applications and approval" below.

Two fields decide whether a person appears, and they answer different questions. `visibility` is whether they belong on the site at all. `profile_status` is whether the record is still live. A person is published only when `visibility: public` and `profile_status: active`; either one alone keeps them off the site, with no card, no filter option and no profile page. `layouts/partials/associate-is-public.html` is the single place that rule lives, so no template has to repeat it.

`leadership: true` exists so the person who leads Frontline World is not printed twice on the same page. Their biography, expertise and links appear in the leadership block; the directory grid holds the wider network.

### Vocabulary

A record stores the ID of a term, never its wording. All the wording lives in `data/vocab/associates.yml`, in six lists. Five describe a person: `expertise`, `roles`, `contributions`, `sectors` and `regions`. The sixth, `programme_families`, holds the six broad categories the Training Academy groups its learning pathways under, and no person record refers to it. Relabelling a term there reaches the directory filters, the profile tags and every record at once.

An ID that is missing from the vocabulary file is ignored rather than shown, so a typo in a record silently drops a tag. The CMS select options are generated from the same file; when a term is added or relabelled there, mirror the change in the `options` list of the matching field in `static/admin/config.yml`.

### Programme catalogue

The Training Academy's learning pathways are programmes. One file per programme in `data/programmes/`, named after its slug, holding a `title`, a `slug`, an optional `family` and an optional `description`. Nothing else: the courses inside a programme are ordinary course records, and the people working on them are named by ordinary assignment records, so a programme file repeats none of that.

The slug is the canonical identifier, and it is the only thing a course or an assignment writes to refer to a programme:

```yaml
# in a course's frontmatter, or an assignment record
programme: <the programme's slug>
```

The name and the description live in the catalogue and are never repeated in the record that points at it, so one edit reaches the programme and everything under it.

The file name and the `slug` inside it must agree, the way an assignment file matches the URL slug of its activity, because that is how a reference resolves. Never change a slug once a course or an assignment refers to it: the reference is the slug, and nothing would follow the move.

### Programme families

A family is the broad category above a programme — one of the six in the `programme_families` list in `data/vocab/associates.yml`. A programme names one by identifier:

```yaml
# in data/programmes/<slug>.yml
family: strategic-foresight-risk-future-thinking
```

The family is a label, not an entity. There is no family record and no family page: the wording lives in the vocabulary list and nowhere else, so the six families are labelled once and every record that refers to one picks the label up from there. `programme_families` is the sixth list in the same vocabulary file the Associate directory uses, reached through the same `vocab-labels.html` lookup, so a programme and an Associate resolve their terms the same way.

A family is also not shown to a visitor. The public Academy page presents Programmes and Courses only, and reads the families to order the programme list. See "How the Academy page presents the catalogue" for the rule and where it is enforced.

A family may be left off a programme for now. Every record in the catalogue sets one, but the validator still treats a missing family as valid and only fails on a wrong one, so a record is not blocked while its family is still being agreed.

Each programme names exactly one family. A programme that spans two is two programmes: a record whose `family` is a list rather than a single identifier fails the build, the same as an unknown family. Where material genuinely covers more than one family, the fix is separate programmes in their own families, not a wider field.

The catalogue holds one programme in five of the six families. The sixth, `conflict-recovery-resilience`, has no programme yet: no course sits naturally in it, and a programme is not invented to fill a gap in a list. Every course names one programme in its own front matter, so each appears under exactly one, and the programme page collects those courses rather than the record listing them.

Decap exposes the catalogue as the Programmes collection, so a programme is created and edited in the CMS like any other record. The `programme` field on an assignment is a plain text field: Decap cannot offer the slugs in `data/programmes/` as a dropdown without custom JavaScript, and this site adds none. A reference is therefore typed and checked against the catalogue by eye.

Because Decap cannot check it, the Hugo build does. `layouts/partials/programmes-validate.html` runs once per build, called from the home page template, and fails the build with an `errorf` when:

* a course or an assignment sets a non-empty `programme` that is not a slug in the registry;
* a record in `data/programmes/` has no `slug` or no `title`;
* a record's file name and its `slug` disagree;
* two records declare the same `slug`;
* a record sets a `family` that is not one of the six in `programme_families`;
* any page outside the `content/programmes/` section publishes anywhere under `/programmes/`.

A missing or empty `programme` is valid, because programme membership is not settled across the site and requiring one would fail the build on correct content. A missing or empty `family` is valid for the same reason. A reference that does not resolve is an error rather than a dropped link: a programme that silently resolves to nothing is the failure this exists to prevent.

### The reserved `/programmes/` namespace

Three namespaces are in play, and the word "programmes" appears in two of them for unrelated reasons.

| URL                                  | Written by                                    | Kind                       |
| ------------------------------------ | --------------------------------------------- | -------------------------- |
| `/training-academy/courses/<slug>/`  | A course's `url:`                             | Canonical course page      |
| `/training-academy/programmes/<slug>/` | A course's `aliases:`                       | Legacy course alias        |
| `/programmes/<slug>/`                | A programme page                              | Reserved for programmes    |

The first two are a course's own two URLs. The third is not a course's to write: it belongs to programme pages alone, and nothing has claimed it yet.

The build protects that reservation. `programmes-validate.html` reads the resolved `RelPermalink` of every page Hugo knows about and fails if one under `/programmes/` comes from outside the `content/programmes/` section. Reading the resolved path rather than the `url:` front matter is the point: `url:` is only one of the things that decide where a page lands — section configuration, file location and permalink settings all feed it — and a course page already publishes to `/training-academy/courses/` while its section is `courses`. A guard that read front matter would be one refactor away from being wrong.

Legitimacy is decided by section rather than by the registry. The registry is empty, and a programme page can exist before its record does, so a registry lookup would reject a legitimate page and would have to be loosened later. Both routes into the namespace are therefore accepted: a programme page relying on the natural section route, and one setting `url: /programmes/<slug>/` explicitly.

This makes a collision impossible rather than unlikely. Hugo does not warn when two pages would write the same output path — one silently wins — so without the guard, giving a course `url: /programmes/<something>/` would quietly take a programme's URL rather than raise anything. The build stops instead, and names the file.

Records go directly in `data/programmes/`, with no subfolder. Hugo flattens that directory when it loads the data, so a nested file is read as a programme with no title and no slug, and the build fails naming a file that does not exist on disk — loud, but a confusing way to learn the rule.

### How a programme page is built

A programme page is never written by hand. One record in `data/programmes/` is the whole page: the content adapter turns it into a page at `/programmes/<slug>/`, and the layout reads the title, the description and the family from it. Adding a record adds the page, its entry on `/programmes/`, and its URL, so there is no second file to keep in step.

| Piece                                | Role                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| `content/programmes/_index.md`       | The `/programmes/` section: the copy around the list, and the message shown while the catalogue is empty. |
| `content/programmes/_content.gotmpl` | The content adapter. It reads `data/programmes/` and generates one page per record, filed under that record's own slug. |
| `layouts/programmes/list.html`       | The index layout: the programmes that exist, or the empty state.                        |
| `layouts/programmes/single.html`     | One programme: title, description, family, and the courses belonging to it.             |
| `layouts/partials/course-name.html`  | The name of a course, for the list on a programme page.                                 |
| `layouts/partials/vocab-labels.html` | Resolves the `family` identifier to its wording, shared with the Associate directory.   |

The courses on a programme page are not listed in the record. The page collects every course whose front matter sets `programme:` to that programme's slug, so membership is written once on the course and the programme picks its courses up. A programme with no courses yet is valid, and the page says so rather than rendering an empty list.

The course pages are still hand-written HTML and carry no `title:` in their front matter, so `course-name.html` reads the course's `<h1>` out of the page body. That is a stopgap for pages that have not been converted yet; once the courses are generated from records with a real title, the helper uses it and the fallback goes.

### How the Academy page presents the catalogue

`content/training-academy.html` keeps the page's own copy and calls two shortcodes, which between them render the catalogue. Neither names a family, a programme or a course, so publishing one adds it to the page with no edit to the template.

| Piece                                        | Role                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `layouts/shortcodes/academy-catalogue.html`   | The Programmes section: one card per programme, each naming the courses inside it.         |
| `layouts/shortcodes/individual-courses.html`  | The Courses grid: one card per course page, ordered by programme.                          |
| `layouts/partials/programme-order.html`       | The catalogue's programme order, in vocabulary family order, shared by both shortcodes.    |
| `layouts/partials/course-name.html`           | A course's name, from its `title:` or its `<h1>`.                                          |
| `layouts/partials/course-lead.html`           | A course's one-line description, from its `summary:` or its `<p class="page-lead">`.        |
| `layouts/partials/course-facts.html`          | A course's Audience and Format, from its `<div class="course-facts">`.                    |

The course cards read the course page rather than repeating it. The title, the description and the delivery facts are the same sentences the course page prints, and the link is the course's own `RelPermalink`, so a course corrected on its own page is corrected everywhere it is listed. A fact the course page does not state is left off its card rather than filled in: `strategic-foresight-for-leaders` states no delivery format, so its card shows an audience line and no format.

A course whose page lead is written to be read rather than scanned can add an optional `summary:` to its front matter, and the cards use that instead of the lead. The key covers the card only; the course page still opens with its own `<p class="page-lead">`. `strategic-foresight-for-leaders` is the only course that sets it.

The public hierarchy is **Programmes → Courses**. Programme families are part of the data model and not part of the page: `academy-catalogue.html` reads the six families to decide the order programmes are listed in and renders nothing about them, so a family is a sort key rather than a public level. A family holding several programmes keeps them adjacent, and a family holding none contributes nothing to the page at all. Do not add a family heading, a family count, or a family label above the programme cards; the page presents two levels and the data model holds three.

Courses are ordered by the programme they belong to, then by name, using the `programme` key the course already carries. That is what keeps the Courses list from reading as six unrelated courses: the two courses in the AI Leadership programme sit together, and the order of the groups matches the programme cards above. A course whose `programme:` names nothing still gets a card, placed last.

`/programmes/` is public and carries a **Programmes** item in the site navigation. The Training Academy page presents the same hierarchy through its own two sections, so the section and the Academy are two ways in to one catalogue rather than two catalogues.

The section was withheld from the sitemap while the programme work was unfinished. Both `sitemap.disable` settings have now been removed: the one `content/programmes/_index.md` set on the section, and the one `content/programmes/_content.gotmpl` set on each generated programme page. The latter sat on the `AddPage` call rather than inside `params`, because that is where Hugo reads it: a nested `sitemap` map under `params` is left as an ordinary page parameter and the page still reaches the sitemap.

Adding the navigation item is a **coordinated change across two kinds of file**. `layouts/partials/site-nav.html` covers the generated pages. The seventeen hand-written pages under `content/` each carry their own copy of the navigation and have to be edited individually, each with its own depth-relative prefix (`programmes/`, `../programmes/`, `../../../programmes/`). Change one and not the others and the section appears on some pages and not others.

### How the pages are put together

| Piece                                | Role                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `content/our-people.html`            | Carries the copy and calls two shortcodes: `associate-leadership` and `associate-directory`. |
| `layouts/partials/associates.html`   | The public records, ordered, with the leadership ones separated out.                         |
| `layouts/partials/associate-card.html` | One directory card.                                                                         |
| `layouts/shortcodes/associate-directory.html` | The grid, the filters and the result status.                                        |
| `content/people/_content.gotmpl`     | A content adapter that generates one page per public record.                                |
| `layouts/people/single.html`         | The profile page layout.                                                                     |
| `layouts/partials/associate-is-public.html` | The publication rule every template asks.                                            |
| `layouts/partials/assignment-team.html` | Renders the people on one assignment.                                                     |
| `layouts/partials/profile-list.html`  | The optional Countries, Subjects, Languages, Qualifications and Experience sections.          |
| `static/script.js`                   | Reveals the filters, filters the cards, and composes the application email.                 |

`content/our-people.html` names no person, so adding a record adds a card, a set of filter options and a profile page at the same time. The whole directory follows the records; the section copy around it does not.

The filter controls ship hidden in the HTML and are revealed by `initAssociateDirectory()` in `static/script.js`, so the grid works without JavaScript. They are not rendered at all while there is only one directory person, because there is nothing to narrow down.

There is no `/people/` index page. The directory is the Our People page; each profile links back to it.

## Applications and approval

`/become-an-associate/` is a self-contained page in `content/`. The form posts
`multipart/form-data` to a dedicated Worker, which validates it and stores it in
a private R2 bucket. A reviewer reads it from `review-worker/`, approves it there,
and the approval writes the associate record to this repository.

### What happens to an application

1. An applicant fills in the eight sections and submits. The browser sends a
   `multipart/form-data` POST to the applications Worker's `/submit` endpoint
   with `fetch()`. With scripting off, the form's own `action` posts the same
   body straight to the same endpoint, so a submission never depends on the
   applicant having JavaScript.
2. The Worker checks, in this order: that the request came from the exact site
   origin, that this connection is under the five-per-hour rate limit, that the
   honeypot is empty, that every required field is present, that the answers are
   acceptable, and the file types. Files are checked on the leading bytes, the
   declared MIME type and the extension together, with size limits of 5 MB for a
   CV and 8 MB for a photograph.
3. The application is written to the private bucket `frontline-applications` as
   `applications/<id>/application.json`, with the CV and photograph next to it
   under generated names, never the applicant's own filenames:

   ```
   applications/<id>/application.json
   applications/<id>/cv/<uuid>.pdf
   applications/<id>/photo/<uuid>.png
   ```

   The record holds the consent answers verbatim. `publication_permitted` is
   `true` only when the applicant answered yes to publishing a profile, and it
   never flips on its own.
4. A reviewer opens the application in `review-worker/` and presses **Approve &
   Create Associate**. The dashboard assembles `data/associates/<id>.yml` from
   the application and the vocabulary in `data/vocab/associates.yml`, and writes
   it through the GitHub Contents API. The record starts
   `visibility: private` and `profile_status: inactive`, carries
   `publication_permitted` copied from the application, and records who approved
   it and when.
5. **Publication is a separate decision.** Making the profile public is its own
   button, and it is refused outright when the applicant did not consent.
6. A photograph is a third decision, again its own button. Approval never
   copies an image into `static/images/`, so accepting someone is never the same
   decision as putting their face on a website.

Every term on the record is validated against the vocabulary before it is
written, and a term the vocabulary does not recognise is dropped rather than
guessed at. The review state is kept separately in R2, so "approved" and "has a
record" cannot drift apart: the record's `application_id` and the review's
`associate_id` are set in the same operation.

### Consent, and where it is read from

The only authority for whether a person may be published is the
`publication_permitted` answer in `applications/<id>/application.json` in R2.
The dashboard re-reads that file on every publication and photograph request and
checks it again, so a value typed into a form, or edited into the record by hand,
is never enough. The site's own gate in `layouts/partials/associate-is-public.html`
applies the same three conditions at build time, which means a record that is
public in the repository still produces no page if its consent says no.

Taking a profile down is never gated: `action=private` is accepted whatever the
consent says, and the dashboard offers **Make Private** on an exposed record even
when publication is not permitted. A rule that blocks a reviewer from undoing an
exposure is not a safety control.

The consent block is digested into a `consent_fingerprint` on both the record and
the review state. If the application in R2 changes after approval, the digests
disagree and the dashboard says so instead of publishing on a stale answer. No
route can change a stored consent answer, which is what makes the mismatch a real
event rather than a routine one.

### The review dashboard

`review-worker/` is a separate Worker from the submission endpoint, for the same
reason: the submission Worker accepts unauthenticated public writes, and the
review Worker holds a token that can write to this repository. They are never
allowed to share a boundary.

Authentication is GitHub OAuth against a reviewer allowlist in `REVIEWER_LOGINS`.
The OAuth token identifies the reviewer and nothing else; all repository writes
use `REPOSITORY_TOKEN`, which never leaves the server. Every state-changing form
carries a CSRF token, including logout.

The write surface is two folders, enforced in code rather than by convention:
`data/associates/<id>.yml` and `static/images/<associate-id>.<jpg|jpeg|png|webp>`.
No route takes a repository path from a request, so a reviewer cannot name a file.

Two failure modes are treated as refusals rather than as success:

- **The repository could not be checked.** A create with no SHA, so GitHub itself
  refuses if the file appeared in the meantime. If the directory listing cannot
  be read, nothing is written, because a list that failed to load is not a list
  of zeroes.
- **A write is refused.** Reported as a conflict and the application stays
  unapproved, so a retry is safe.

Reads the dashboard acts on — the vocabulary, the directory listing and the
record it is about to change — are always fresh, never cached, so a reviewer
never sees a state that has already moved.

### Running the dashboard locally

```sh
# the submission endpoint
(cd applications-worker && npx wrangler dev --port 8801)

# the dashboard
(cd review-worker && npx wrangler dev --port 8802)
```

The dashboard needs `REPOSITORY_TOKEN` and `GITHUB_REPO` in
`review-worker/.dev.vars` (git-ignored). Start the two Workers sequentially
against a shared `--persist-to` directory; starting them together can leave one
holding the SQLite lock.

`review-worker/test-github-stub.js` is an in-memory stand-in for the GitHub
Contents API, so the whole approval and publication workflow can be exercised
without a real token and without writing to this repository:

```sh
node test-github-stub.js 8803     # in one terminal
./test.sh                         # in another
```

### Putting the dashboard in front of reviewers

The dashboard is not live until three credentials exist, and two of them have to
be created outside this repository.

1. **A GitHub OAuth App of its own.** A GitHub OAuth App has exactly one callback
   URL and no wildcard, so this Worker cannot share `oauth-proxy`'s App: two
   Workers on two different hosts cannot both match. Create a second App with the
   callback URL set to
   `https://frontline-applications-review.<subdomain>.workers.dev/callback`.
   The scope is `read:user`, and the callback reads only which account signed in.
2. **A fine-grained personal access token** with "Contents: read and write" on
   this repository and nothing else. This is the credential that writes records,
   so it is the one worth scoping tightly. A GitHub App installation token works
   the same way if you would rather not use a personal token.
3. **A session secret**, which is any long random string:
   `openssl rand -base64 48`.

Then:

```sh
cd review-worker
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put REPOSITORY_TOKEN
npx wrangler secret put SESSION_SECRET   # the value from step 3
npx wrangler deploy
```

`ALLOWED_USERS`, `GITHUB_REPO` and `REPOSITORY_BRANCH` are already in
`wrangler.toml`. Nothing else is needed: the R2 bucket binding is there, and the
`.dev.vars` file that holds `GITHUB_API_BASE` and `ALLOW_TEST_RESET` for the test
suite is never uploaded by `wrangler deploy`. A deployed Worker therefore has no
test-login route and cannot be pointed at a stand-in.

To check the deploy before anyone depends on it, load `/login` and confirm the
page offers GitHub sign-in and nothing else. A Worker deployed without its
secrets still answers, with a sign-in button that fails — which is why the
first thing to test is a real sign-in, not a 200.

### What is stored, and where

An application lives in the private R2 bucket `frontline-applications`, which has no
public domain and no public URL for any object. It is written by the applications
Worker and read by the review dashboard. Three things are stored per application:

| What | Where | Notes |
| --- | --- | --- |
| The application record | `applications/<id>/application.json` | Name, contact details, biography, qualifications, and the consent block as submitted. |
| The CV | `applications/<id>/cv/<uuid>.<ext>` | Stored under a generated name, never the applicant's own filename. |
| The photograph | `applications/<id>/photo/<uuid>.<ext>` | Same. Required by the form, but not published by approving. |
| The review decision | `review/<id>/state.json` | Status, the notes, the history, and the timestamps the retention clock reads. |
| The last sweep's report | `retention/last-run.json` | What was deleted, what was kept, and what failed. |

There is no applicant account and no mail step, so there is no applicant-facing
copy of any of this and no way for an applicant to ask for it through the site.
A withdrawal is recorded by a reviewer, not requested by the applicant in
self-service.

### How long application data is kept

These are the organisation's own operational periods. They are not a statement
about what any law requires, and they are not legal advice — someone responsible
for data protection should confirm them against the obligations that actually
apply.

| Outcome | Kept for | Counted from | What happens after |
| --- | --- | --- | --- |
| Rejected | 12 months (365 days) | The final rejection decision | The record, the CV and the photograph are deleted. |
| Withdrawn | 30 days | The withdrawal | The record, the CV and the photograph are deleted. |
| Approved | 24 months (730 days) | Approval | Raised for a person to decide. The application is **never** deleted automatically. Its CV is removed, and its photograph once it is published or was never publishable. |
| Under review | No limit | — | Kept in full. |

An approved application is deliberately never deleted automatically, for two
reasons. The published Associate record carries `application_id` and a
`consent_fingerprint`, and that link back to the answer the record was built from
is the only way to show a published profile rests on a real consent. And the
policy itself asks for a decision after 24 months rather than a deletion.

### When deletion actually happens

A scheduled Worker sweeps the bucket at **04:17 UTC every day**. The rules live in
`review-worker/lib/retention.js` as pure functions; `review-worker/lib/cleanup.js`
carries them out and writes the report.

**This is a scheduled Worker rather than an R2 lifecycle rule, and the reason is
structural.** A lifecycle rule matches on a prefix and an age in days. It cannot
open an object and read a field. Retention here turns on `status`, which lives
inside the object bodies, so a lifecycle rule could only delete every application
on one fixed schedule — which would destroy applications still under review — or
never fire at all.

A reviewer can also run a sweep by hand from the Applications page. It is a
delete, so it is a POST behind a session and a CSRF token like every other write.

**The clock is stamped on the decision, not on the file.** `rejected_at`,
`withdrawn_at` and `approved_at` are set by `saveReview` on the transition into
that state, and re-stamped if an application is rejected again after being
reopened, because the period counts from the final decision. They are not derived
from `updated_at`, which a later note would move. Records written before the
stamps existed are dated from the matching entry in their history.

### Withdrawals and holds

A withdrawal is the applicant ending the process, and it is a distinct status
from a rejection because it carries a different period. Setting it requires a
short reason: the policy deletes these in 30 days, and a deletion nobody wrote
down is not defensible. The reason goes into the review history.

Either outcome can be held past its period. A hold needs **both** a date and a
reason; either alone is not a hold, so a half-filled form cannot quietly keep an
application. Both are set on the status form, and clearing both releases the hold.

### What the sweep will not do

- It does not delete an application that is submitted, under review, awaiting
  changes, or archived. A submission nobody has looked at is not finished with.
- It does not delete an application merely because a fixed number of days has
  passed. Age is only ever read together with a status and a decision date.
- It does not delete a photograph that could still be needed. A photograph is
  discarded only once it has been published, or once the applicant declined
  publication and so it can never be published. An unpublished photograph of a
  consenting applicant is the only copy, and is kept.
- It does not touch anything outside `applications/<id>/` and `review/<id>/` for an
  id that matches the generated format. Every key is built from a validated id,
  so a malformed key is refused rather than followed.
- It does not report a deletion it cannot confirm. Every deletion is followed by a
  re-listing of the same prefix, and anything still there is recorded as a
  failure. Uploads are deleted before the record, so a partial failure leaves a
  whole application for the next sweep rather than an orphan.

A failure on one application does not stop the sweep. Failures are listed at the
top of the Applications page and in `retention/last-run.json`, because a deletion
that silently did not happen is the failure mode worth being loud about.

### Application data and the Associate record are different things

The **application** is a private record of a process: what someone applied with,
what they uploaded, and what was decided. It lives in R2 and is deleted on the
schedule above.

The **Associate record** is `data/associates/<id>.yml` in this repository. It is
the public profile, it is built from the application at the moment of approval,
and it stays while the Associate relationship and profile are active, subject to
periodic review. It is not deleted by the retention sweep, and deleting the
application does not delete it.

What crosses from one to the other is deliberately narrow. The public record
carries `application_id`, `publication_permitted`, a `consent_fingerprint`,
`approved_at` and `approved_by`. It does not carry the applicant's email, their
literal consent answer, their consent timestamp, their CV, reviewer notes, or any
bucket key. The consent answer and timestamp stay in the private bucket.

### What the form can and cannot do

The required photograph and the 5 MB / 8 MB file limits are named on the
page and enforced again on the server.

A photograph is required on the form, because an associate profile without one is not publishable. Approval still does not publish it: the image stays in the private bucket until a reviewer publishes it separately, and only where the applicant consented.


### Privacy limits worth knowing

`data/private/` sits outside `static/`, so Hugo never copies it into `public/` and no built page can link to it. `.gitignore` also excludes everything in it except the `.gitkeep` files, so an application saved through the CMS is never committed or pushed.

**This is staging, not storage.** It is a local folder on whichever machine the CMS writes to, which is not a system of record, not backed up, and not access-controlled. It is kept for CMS compatibility and for applications that still arrive by email; the production store for applications and their uploads is R2 behind the submission Worker. Keep anything genuinely sensitive out of it, and treat it as temporary until the CMS can read from R2.

  ### The applications Worker and its R2 bucket

  Submission runs through `applications-worker/`, a Worker kept separate from the CMS OAuth proxy on purpose: the OAuth Worker holds credentials for writing the site, and the submission Worker accepts unauthenticated public writes, so the two are never allowed to share a boundary or an outing. Its `/submit` endpoint stores each application as three objects in the private bucket `frontline-applications`: the `application.json` record plus the CV and photo under generated names. That bucket was created without a public domain, so no object in it has a public URL, and the Worker never returns one.

  The Worker's secrets live in `applications-worker/.dev.vars` (git-ignored) locally and in Cloudflare secrets in production; the bucket binding and the rate-limit KV namespace are configured in `applications-worker/wrangler.toml`. Before the first deploy, the bucket and KV namespace must exist:

  ```sh
  npx wrangler r2 bucket create frontline-applications
  npx wrangler kv namespace create RATE_LIMIT   # then paste its id into wrangler.toml
  npx wrangler secret put TURNSTILE_SECRET      # only if Turnstile is enabled
  ```

  Applications are read out of R2 with the Cloudflare API, `wrangler r2 object get`, or a temporary signed URL issued to the reviewer — never through a permanent public link. The dashboard in `review-worker/` reads them through its R2 binding and serves them only to a signed-in reviewer. The CMS Applications collection in `data/private/applications/` remains the working review record for applications that arrive by email. A record created by the dashboard carries `publication_permitted` and a `consent_fingerprint`, which is a digest of the answer rather than the answer itself, so the consent text stays in the private bucket.

  `static/admin/config.yml` is published at `/admin/config.yml`, so the collection names, the folder paths and every field label are visible. No applicant data is in that file.

`static/admin/config.yml` is published at `/admin/config.yml`, so the collection names, the folder paths and every field label are visible. No applicant data is in that file.

## Making updates

### Change the copy on a page

Edit the HTML in the page's file under `content/`. Update the text between tags, and leave the tags and classes alone.

### Add an article

1. Copy an existing article in `content/insights/` to a new file named after the slug.
2. Edit its `<head>`, its article header, and its body.
3. Add a card to the listing in `content/insights/_index.html`.
4. Add the article to the home page: the "Latest Insights" cards and the news ticker in `content/_index.html`.

The listing, the home cards, and the ticker all read the article frontmatter, so they update themselves. See "List maintenance" below.

### Add a course

1. Copy an existing file in `content/courses/`.
2. Set `url` in frontmatter to `/training-academy/courses/<slug>/`.
3. Edit the copy, including the title, audience, and format facts.
4. Add the course to the list in `content/training-academy.html`.

### Add or edit an assignment team

Every course supports several people, displayed between "What the course covers" and the "Audience" section. The same shape serves a programme or a project, so one file describes the people on any piece of work.

A person on an assignment is a person in the Associate Directory, not a copy of one. Assignment data lives in one file per assignment at `data/assignments/<slug>.yml`, and the file name must match the course's URL slug exactly. Each entry in `team` names an associate ID and, at most, what belongs to that assignment:

```yaml
type: course
title: AI in Teaching and Learning
slug: ai-in-teaching
team:
  - associate: saeed-abuzour
    assignment_role: Trainer
```

| Key               | Purpose                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `programme`       | The learning pathway this activity belongs to, as a stable identifier. Optional, and unset on every file today. |
| `associate`       | The person's ID, which is the file name of their record in `data/associates/`.                 |
| `assignment_role` | What they do on this assignment, shown above their name. Optional.                            |
| `title`           | An assignment-specific title, when it should differ from the one on their record. Optional.   |
| `focus`           | A short line under their name. Optional.                                                     |
| `order`           | Position in the group; lower comes first. Optional.                                           |
| `visible`         | `false` keeps the entry out of the page without deleting it. Optional.                        |

`type` and `title` describe the assignment itself; `slug` repeats the file name so the CMS can show it.

The name, title, organisation, photo and biography are read from the record, so changing a person changes the assignment too. An entry that names no known associate falls back to whatever the entry carries, which lets someone be listed before their record exists. An empty file renders the "profiles will be announced soon" placeholder.

Admin-editable through the CMS: the Admin page "Assignments" collection edits these files, and the "Associates" collection edits the people they point at. Photos upload to `static/images/`; the course pages themselves are not CMS-editable.

GitHub sign-in runs in a pop-up window: editors must allow pop-ups for `frontlineworld.org` and `frontline-cms-oauth.wesaam-amer.workers.dev`, or the login never completes.

The names link to their profile, and the "Meet Our People" link below the grid points at the directory on the Our People page.

> **CMS testing status:** the CMS UI, its OAuth proxy, and the GitHub backend have not yet been fully tested locally. Verify assignment, associate and application editing in the live/admin environment before relying on it.

> **Older files:** `layouts/shortcodes/course-trainers.html` still falls back to `data/trainers/<slug>.yml` and a `trainers:` list, so a file in the old shape keeps rendering. All six records have been converted; the fallback is there for anything added later in the old form. The folder itself is gone.

### Add an associate

1. Copy an existing file in `data/associates/` to `data/associates/<id>.yml`, where the ID is the person's name in lowercase with hyphens.
2. Fill in the record. Use the vocabulary IDs from `data/vocab/associates.yml` for expertise, roles, contributions, sectors and regions.
3. Put the photo in `static/images/` and set `photo` to its file name.
4. Leave `visibility: private` and `profile_status: active` until the person is announced, then set `visibility: public`.
5. Run `hugo` and open the Our People page and `/people/<id>/`.

No page needs editing. Tick `leadership` only for the person who leads Frontline World.

### Add a page

1. Create `content/<name>.html`. Copy a similar page as a starting point so the head, navigation, and footer stay consistent.
2. Fix the relative link depth for its location.
3. Add a navigation link on every page if the page belongs in the menu.

Never add a file under `content/people/`: the profile pages there are generated from the records, and a file added by hand is overwritten or ignored.

### Change the navigation

Edit the `<header class="site-header">` block in every file under `content/`. Update the `<footer class="footer">` block there too if the footer links change.

### Change styles or layout

Edit `static/styles.css`. Design tokens (colors, fonts, widths, easings) are CSS custom properties at the top of the file; reuse them instead of adding literal values.

Page layout lives in the page files. To change a section's structure, edit the markup in the relevant page.

### Move a page without breaking links

Change the file name or the `url` field, then add the old path to `aliases` in frontmatter so Hugo emits a redirect.

### Images live in the project

Every image on the site lives in `static/images/`. Never reference an image from outside the project. Save it into the project first, then link the local copy from the page that uses it:

- **From a link**: download the image into `static/images/`.
- **From a local file**: copy the file into `static/images/`.

Use a descriptive file name, then link it from the page with a relative path (see the depth table above) and an `alt` description.

### Replace a placeholder image

Pages use a branded placeholder until real photography exists. To add a real image:

1. Put the file in `static/images/`.
2. Find the `<figure class="image-frame ...">` block for that slot.
3. Replace the placeholder markup with `<img src="<relative path>" alt="<description>" loading="lazy">`.
4. Keep the surrounding `<figure>` and its classes so the framing stays consistent.

### Preview, build, and deploy

```bash
hugo server    # live reload
hugo           # build the static site to public/
```

`baseURL` is the custom domain, so `hugo server` serves the site at the root: open `http://localhost:1313/`.

Push to `main` to build and deploy through GitHub Actions. The workflow in `.github/workflows/hugo.yml` runs `hugo --minify` and publishes the result to GitHub Pages.

## List maintenance

The insights content updates itself. The "Latest Insights" cards and the news ticker on the home page are shortcodes, and the grid on `content/insights/_index.md` is generated by a layout. All three read the same article frontmatter, so adding or removing an article in `content/insights/` is enough. Set the `date` to control recency, `weight` to control listing order, and the optional `teaser` to control the short home page line.

Two lists are still part of the page HTML and do not update themselves:

- The course list on `content/training-academy.html`.
- The insights ticker is capped at 6 articles and the cards at 4, so older articles appear on the Insights listing only.

The associate directory updates itself in the same way: the cards, the filter options and the profile pages are all generated from `data/associates/`, so a record is the only thing to add or change.

## Conventions

- Keep each page self-contained. Do not move page copy into `layouts/`; the templates there are plumbing, not a place to rewrite a page.
- Write a person once, in `data/associates/`, and refer to them by ID. Do not repeat a name, title, organisation, photo or biography in a page or in assignment data.
- Keep the public record and the application apart. Anything administrative belongs in `data/private/applications/<id>.yml`, never in `data/associates/`.
- Never reference external images. Download or copy every image into `static/images/` before linking it.
- Do not invent URLs, contact details, social profiles, or photo credits. Use the placeholder in the page until real assets exist.
- Reuse the design tokens in `static/styles.css` rather than introducing new colors, fonts, or spacing values.
- Keep relative links depth-correct, per the table above.
- Do not edit generated output in `public/` or `resources/`.
- Do not add taxonomies without an explicit request.

## Configuration notes

`hugo.toml` sets `baseURL`, the site title, the disabled taxonomies, the Markdown settings, and the HTML content permission.

The `[params]` values (description, email, phone, social profiles) and the `[menus]` entries are left over from an earlier version of the site. Pages no longer read them, because contact details and navigation are written directly into the HTML. They are safe to remove.
