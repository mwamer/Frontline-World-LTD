# Frontline World Ltd

Public website for Frontline World Ltd, an interdisciplinary consultancy. Built with [Hugo](https://gohugo.io) and deployed to GitHub Pages.

## Project Structure

```
├── content/                     # Markdown content (edit these)
│   ├── _index.md                # Homepage content
│   ├── about.md                 # About page
│   ├── approach.md              # Approach page
│   ├── contact.md               # Contact page (mailto links)
│   └── news/                    # News articles
│       ├── _index.md            # News listing page
│       └── *.md                 # Individual articles
├── layouts/                     # HTML templates
│   ├── _default/
│   │   ├── baseof.html          # Shared layout (head, nav, footer)
│   │   └── single.html          # Standard page layout
│   ├── index.html               # Homepage layout
│   ├── news/
│   │   ├── list.html            # News listing
│   │   └── single.html          # Single article
│   └── partials/
│       ├── head.html            # <head> tag
│       ├── nav.html             # Navigation
│       └── footer.html          # Footer
├── static/                      # Copied as-is to the built site
│   ├── styles.css
│   ├── script.js
│   └── images/                  # Images (news featured images, etc.)
├── hugo.toml                    # Hugo configuration
└── .github/workflows/hugo.yml   # GitHub Pages deploy workflow
```

## Editing Content

All site content lives in `content/` as Markdown files. Add a frontmatter block at the top of each file:

```markdown
---
title: "My Article Title"
date: 2026-09-06
description: "A short summary shown in listings."
news_type: "Commentary"         # Category shown on cards
image: "images/article.png"     # Optional featured image
draft: false
---

Content here in Markdown...
```

To publish a new news article: create a file in `content/news/`, push to `main`, and the site redeploys automatically. The homepage shows the latest 6 articles.

## Local Development

```bash
brew install hugo
hugo server    # live reload at http://localhost:1313/
```

Build the static site to `public/`:

```bash
hugo
```

## Deployment

Push to `main`. The GitHub Actions workflow (`.github/workflows/hugo.yml`) builds the site and deploys it to GitHub Pages automatically.