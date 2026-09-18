# Agent guide

Read `README.md` first. It is the source of truth for this project's structure and update workflows. Follow it for every change.

## Core rule: the page file is the source of truth

- Every page is one complete HTML file in `content/`, containing its own head, navigation, content, and footer. Edit that file.
- Do not move page copy into `layouts/`. Those files are single-line passthrough templates.
- Never edit generated output in `public/` or `resources/`.

## Working method

- Read `README.md` before touching files.
- Build with `hugo` before and after your change. It must finish without errors.
- For visual changes, run `hugo server` and inspect `http://localhost:1313/Frontline-World-LTD/`. Screenshots belong in `.openchamber/screenshots/`, which is git-ignored.
- Run `git status` and review the diff before you finish.

## Watch for these

- **Relative links.** Match the depth table in `README.md`. Never write `/Frontline-World-LTD/...`; it breaks a custom domain.
- **Repeated chrome.** Head, navigation, and footer are copied into every page. If they change, update every file under `content/`.
- **Manual lists.** The home insights cards, the news ticker, the insights grid, and the course list are hand-written. Update the matching list when you add or remove an article or course.
- **`security.allowContent`.** Keep `allowContent = ['^text/html$']` in `hugo.toml`, or the build fails.

## Do not

- Do not invent URLs, email addresses, phone numbers, social profiles, or photo credits. Keep the page placeholder until real assets exist.
- Do not add colors, fonts, or spacing values that bypass the tokens in `static/styles.css`.
- Do not add taxonomies without an explicit request.
- Do not commit, push, or open a pull request unless asked.

There is no test suite or linter. A clean `hugo` build is the required check.
