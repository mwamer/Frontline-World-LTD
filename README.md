# Frontline World Ltd

Public website for Frontline World Ltd. It is a static site built with [Hugo](https://gohugo.io) and published to GitHub Pages.

## What this project is

The site uses plain Hugo: no theme, no package manager, and no build step other than the `hugo` command.

- **Every page is one complete HTML file** in `content/`.
- **`layouts/` holds small passthrough templates** that hand each file to Hugo unchanged.
- **`static/` holds the CSS, JavaScript, and images.**
- **`hugo.toml` holds site configuration.**
- Pushing to `main` rebuilds and deploys the site through GitHub Actions.

## Content and layout live together

This site does not split content and presentation. Each page is a single HTML file that already contains its own `<head>`, navigation, page content, and footer. Hugo renders the file as it is.

To change a page, edit its file in `content/`. There is no separate template to keep in sync. This is the main rule for working in this repository: **the page file is the source of truth.**

## Project structure

```
.
├── content/                       # Every page: a complete HTML file
│   ├── _index.html                # Home
│   ├── <page>.html                # Top-level pages (about, services, ...)
│   ├── insights/
│   │   ├── _index.html            # Insights listing
│   │   └── <article>.html         # Articles
│   └── courses/
│       └── <course>.html            # Courses (served under /training-academy/)
├── layouts/                       # Passthrough templates only
│   ├── index.html                 # Home
│   ├── _default/single.html       # Regular pages
│   └── insights/list.html         # Insights listing
├── static/                        # Copied unchanged into the built site
│   ├── styles.css                 # All site CSS, with design tokens at the top
│   ├── script.js                  # Site JavaScript
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

The document head, navigation, and footer appear in full in every page file. There are no partials. This keeps each page self-contained, at the cost of repetition.

When you change the navigation or footer, change it in every file under `content/`. Use search and replace, and check the result.

## Making updates

### Change the copy on a page

Edit the HTML in the page's file under `content/`. Update the text between tags, and leave the tags and classes alone.

### Add an article

1. Copy an existing article in `content/insights/` to a new file named after the slug.
2. Edit its `<head>`, its article header, and its body.
3. Add a card to the listing in `content/insights/_index.html`.
4. Add the article to the home page: the "Latest Insights" cards and the news ticker in `content/_index.html`.

The listing, the home cards, and the ticker are written by hand. Nothing adds them automatically. See "Manual list maintenance" below.

### Add a course

1. Copy an existing file in `content/courses/`.
2. Set `url` in frontmatter to `/training-academy/courses/<slug>/`.
3. Edit the copy, including the title, audience, and format facts.
4. Add the course to the list in `content/training-academy.html`.

### Add a page

1. Create `content/<name>.html`. Copy a similar page as a starting point so the head, navigation, and footer stay consistent.
2. Fix the relative link depth for its location.
3. Add a navigation link on every page if the page belongs in the menu.

### Change the navigation

Edit the `<header class="site-header">` block in every file under `content/`. Update the `<footer class="footer">` block there too if the footer links change.

### Change styles or layout

Edit `static/styles.css`. Design tokens (colors, fonts, widths, easings) are CSS custom properties at the top of the file; reuse them instead of adding literal values.

Page layout lives in the page files. To change a section's structure, edit the markup in the relevant page.

### Move a page without breaking links

Change the file name or the `url` field, then add the old path to `aliases` in frontmatter so Hugo emits a redirect.

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

The site is served under `/Frontline-World-LTD/`, so open `http://localhost:1313/Frontline-World-LTD/`.

Push to `main` to build and deploy through GitHub Actions. The workflow in `.github/workflows/hugo.yml` runs `hugo --minify` and publishes the result to GitHub Pages.

## Manual list maintenance

Four lists are part of the page HTML and do not update themselves:

- The "Latest Insights" cards on the home page.
- The news ticker on the home page.
- The insights grid on `content/insights/_index.html`.
- The course list on `content/training-academy.html`.

When you add or remove an article or course, update the matching list by hand.

## Conventions

- Keep each page self-contained. Do not move page copy into `layouts/`; those files are passthrough plumbing.
- Do not invent URLs, contact details, social profiles, or photo credits. Use the placeholder in the page until real assets exist.
- Reuse the design tokens in `static/styles.css` rather than introducing new colors, fonts, or spacing values.
- Keep relative links depth-correct, per the table above.
- Do not edit generated output in `public/` or `resources/`.
- Do not add taxonomies without an explicit request.

## Configuration notes

`hugo.toml` sets `baseURL`, the site title, the disabled taxonomies, the Markdown settings, and the HTML content permission.

The `[params]` values (description, email, phone, social profiles) and the `[menus]` entries are left over from an earlier version of the site. Pages no longer read them, because contact details and navigation are written directly into the HTML. They are safe to remove.
