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
│   ├── private/                   # Never served: applications and their uploads
│   │   ├── applications/<id>.yml  # One application, plus the review history
│   │   └── uploads/               # Photographs and CVs sent with an application
│   └── vocab/associates.yml       # The wording behind every expertise, role, sector, region
├── layouts/                       # Passthrough templates, partials and shortcodes
│   ├── index.html                 # Home
│   ├── _default/single.html       # Regular pages
│   ├── insights/list.html         # Insights listing
│   ├── people/single.html         # Associate profile
│   ├── partials/                  # Shared pieces, including the directory and profile helpers
│   └── shortcodes/                # Assignment teams, leadership block, associate directory, form options
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

| Page URL                               | Home        | Another page              | Asset                 |
| -------------------------------------- | ----------- | ------------------------- | --------------------- |
| `/`                                    | `./`        | `about/`                  | `styles.css`          |
| `/about/`                              | `../`       | `../services/`            | `../styles.css`       |
| `/insights/welcome/`                   | `../../`    | `../../about/`            | `../../styles.css`    |
| `/training-academy/courses/<slug>/` | `../../../` | `../../training-academy/` | `../../../styles.css` |

Rules:

- Never start a link or asset path with `/Frontline-World-LTD/`. That hard-codes the deployment path and breaks a custom domain.
- To link to a section on another page, add the fragment: `../services/#strategic-research`.
- To link to a section on the same page, use just the fragment: `#courses`.

## Shared pieces are repeated on every page

The document head, navigation, and footer appear in full in every hand-written page file. That keeps each page self-contained, at the cost of repetition.

When you change the navigation or footer, change it in every file under `content/`. Use search and replace, and check the result.

The generated parts of the site do share their chrome, because they are built by a template rather than written out: `layouts/people/single.html` and `layouts/insights/list.html` call the same `site-head`, `site-nav` and `site-footer` partials. A change to a partial therefore reaches those pages, and the repeated markup in `content/` still needs editing by hand.

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

A record stores the ID of a term, never its wording. All the wording lives in `data/vocab/associates.yml`, in five lists: `expertise`, `roles`, `contributions`, `sectors` and `regions`. Relabelling a term there reaches the directory filters, the profile tags and every record at once.

An ID that is missing from the vocabulary file is ignored rather than shown, so a typo in a record silently drops a tag. The CMS select options are generated from the same file; when a term is added or relabelled there, mirror the change in the `options` list of the matching field in `static/admin/config.yml`.

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

`/become-an-associate/` is a self-contained page in `content/`, and the applications it produces are reviewable in the CMS. Nothing about it is automatic: there is no server, so an application arrives as an email, and someone files it.

### What happens to an application

1. An applicant fills in the eight sections and submits. The page opens their email app with the answers in the message body, addressed to the same address the rest of the site shows, which is written into the form's `action` because the pages do not read `hugo.toml`.
2. Someone creates a record in the CMS "Applications" collection, in `data/private/applications/<id>.yml`, and sets `status: submitted` and `date_submitted`.
3. The reviewer moves the status through `under-review`, and either `changes-requested`, `approved` or `rejected`. Each step adds a `review` list entry, so the history accumulates rather than being overwritten.
4. On approval, the reviewer creates the person's record in `data/associates/<id>.yml` and copies across the public fields, then sets `visibility` to match `public_consent` on the application.
5. A photograph or CV has to be copied out of `data/private/uploads/` into `static/images/` by hand before it can appear on the site.

The application file names the same ID as the associate record, so the two files sit side by side and never hold the same field twice.

| In `data/private/applications/<id>.yml` | In `data/associates/<id>.yml` |
| --------------------------------------- | ------------------------------ |
| `email`, `linkedin`, `country`, `current_role` | — |
| `photo`, `cv` in `data/private/uploads/` | `photo` in `static/images/` |
| `availability`, `constraints` | — |
| `bio_short`, `bio_long` | `summary`, `bio` |
| `expertise`, `roles`, `contributions`, `sectors`, `regions`, `countries` | the same IDs, unchanged |
| `qualifications`, `experience`, `teaching_subjects`, `languages` | the same, one list entry per line |
| `status`, `date_submitted`, `date_decided`, `date_approved`, `review`, `admin_notes` | — |
| `public_consent`, `consent_confirmed` | `visibility`, `profile_status` |

The field names in the application collection, in the form, and in the email an applicant sends are the same, so transcribing an email into a record is a copy rather than a translation. The expertise, sector, region, role and contribution options in the form come from `data/vocab/associates.yml` through the `vocab-options` shortcode, and the CMS `options` lists mirror that file.

### What the form can and cannot do

The site is static, so the form has nothing to post to. With scripting on, `initAssociateApplication()` in `static/script.js` reads the form, lays it out under the same section headings, and hands it to the visitor's email app. With scripting off, the form falls back to its own `mailto` action, as the partnership form on `/our-people/` already does. Either way the applicant sends the email themselves.

**An email carries text only.** The photograph and the CV are named in the message so the reviewer knows what to expect, but the applicant has to attach both by hand. The page says so, and the status line repeats it after submitting.

A photograph is required on the form, because an associate profile without one is not publishable, but nothing stops a reviewer approving a record that has no image.

### Privacy limits worth knowing

`data/private/` sits outside `static/`, so Hugo never copies it into `public/` and no built page can link to it. `.gitignore` also excludes everything in it except the `.gitkeep` files, so an application saved through the CMS is never committed or pushed.

**This is staging, not storage.** It is a local folder on whichever machine the CMS writes to, which is not a system of record, not backed up, and not access-controlled. It exists to hold an application between the moment it arrives by email and the moment it is transcribed. Keep anything genuinely sensitive out of it. The production store for applications and their uploads will be R2, behind the submission Worker; that is not built yet, so nothing here should be kept on the strength of it.

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
