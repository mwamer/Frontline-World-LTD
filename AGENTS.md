# Agent guide

Read `README.md` first. It is the source of truth for this project's structure and update workflows. Follow it for every change.

## Core rule: the page file is the source of truth

- Every hand-written page is one complete HTML file in `content/`, containing its own head, navigation, content, and footer. Edit that file.
- Do not move page copy into `layouts/`. The passthrough templates there are a single line each; the partials and shortcodes are plumbing for the generated parts only.
- A person lives once, in `data/associates/<id>.yml`. Pages, courses and profiles all read that record, so never write a name, title, organisation, photo or biography into a page or into course data.
- Never edit generated output in `public/` or `resources/`, and never add a file under `content/people/`: those profile pages are generated from the records.

## Working method

- Read `README.md` before touching files.
- Build with `hugo` before and after your change. It must finish without errors.
- For visual changes, run `hugo server` and inspect `http://localhost:1313/Frontline-World-LTD/`. Screenshots belong in `.openchamber/screenshots/`, which is git-ignored.
- Run `git status` and review the diff before you finish.

## Watch for these

- **Relative links.** Match the depth table in `README.md`. Never write `/Frontline-World-LTD/...`; it breaks a custom domain.
- **Repeated chrome.** Head, navigation, and footer are copied into every hand-written page. If they change, update every file under `content/`. The generated pages share the `site-head`, `site-nav` and `site-footer` partials instead.
- **Generated pages.** The associate directory comes from `content/our-people.html` calling `associate-leadership` and `associate-directory`, and the profiles from `content/people/_content.gotmpl` with `layouts/people/single.html`. Edit those, not the output. Filter options and profile tags resolve IDs through `data/vocab/associates.yml`; an ID missing there is dropped silently.
- **Mostly automatic lists.** The home insights cards, the news ticker, and the insights grid are generated from `content/insights/` frontmatter, so they need no edits. The course list is still hand-written. Ordering comes from `layouts/partials/insights-latest.html`; change it there, not in the page.
- **Images are always local.** Never reference an image from outside the project. Given a link, download it into `static/images/`; given a local path, copy it into `static/images/`. Then link the local file with a relative path from the page that uses it.
- **`security.allowContent`.** Keep `allowContent = ['^text/html$']` in `hugo.toml`, or the build fails.

## Do not

- Do not invent URLs, email addresses, phone numbers, social profiles, or photo credits. Keep the page placeholder until real assets exist.
- Do not add colors, fonts, or spacing values that bypass the tokens in `static/styles.css`.
- Do not add taxonomies without an explicit request.
- Do not invent a person. A record needs a real name, a real role, and a real source for every fact in it.
- Do not commit, push, or open a pull request unless asked.

There is no test suite or linter. A clean `hugo` build is the required check.
