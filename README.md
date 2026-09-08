# Frontline World Ltd

Public website and admin dashboard for Frontline World Ltd, an interdisciplinary consultancy.

## Project Structure

```
├── index.html              # Homepage (hero, expertise, sectors, projects, contact)
├── about.html              # Company overview, framework, team
├── approach.html           # Methodology and framework
├── contact.html            # Contact form
├── insights.html           # Public news/insights listing (Supabase-powered)
├── insight.html            # Single insight view (loaded by slug)
├── dashboard.html          # Admin CMS dashboard (requires authentication)
├── styles.css              # Shared stylesheet
├── script.js               # Shared JS (mobile nav, contact form, smooth scroll)
├── dashboard.js            # Dashboard logic (CRUD for insights, enquiries, team, content)
├── auth.js                 # Supabase auth helpers (session, sign-in, sign-out, role check)
├── config.js               # Supabase project credentials (URL + anon key)
└── .github/workflows/      # GitHub Pages deployment via Jekyll
```

## Getting Started

### Prerequisites

- A modern web browser
- A local HTTP server (e.g., `python3 -m http.server`, `npx serve`, or VS Code Live Server)
- For the admin dashboard: a [Supabase](https://supabase.com) project with the required tables and storage bucket

### Running Locally

1. Clone the repository
2. Start a local server from the project root:
   ```
   python3 -m http.server 8000
   ```
3. Open `http://localhost:8000` in your browser

### Dashboard Setup

1. Create a Supabase project
2. Update `config.js` with your Supabase URL and anon key
3. Run the required SQL schema in the Supabase SQL editor (tables: `insights_posts`, `enquiries`, `team_members`, `content_blocks`, `profiles`)
4. Create a `media` storage bucket in Supabase for image uploads
5. Ensure the authenticated user has a profile row with role `admin` or `editor`

### Deployment

The site deploys automatically to GitHub Pages on push to `main` via the GitHub Actions workflow.
