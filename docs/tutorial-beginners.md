# Beginner's Tutorial: Install and Use the Nomad CMS

Welcome! This guide walks you through getting the **Nomad CMS** running on your computer for the first time, and shows you how to use it to edit a website stored on GitHub.

If you've never used a terminal, npm, or GitHub before, don't worry — every step is explained below.

---

## 1. What is this project?

The **Nomad CMS** is a tool that lets you edit a plain HTML website (the kind made of simple `.html` files) through a visual editor in your browser — without needing to hand-edit code.

It works like this:

1. You sign in with your **GitHub** account.
2. You pick one of your **repositories** (a project folder on GitHub) that contains HTML files.
3. The CMS finds all the HTML pages in that repository.
4. You open a page in a visual editor, change text, swap images, or add/remove elements.
5. You hit **Save**, and the CMS commits your changes back to GitHub as a new commit.

This is great for simple static sites (portfolio pages, landing pages, small business sites) that are hosted on services like **Cloudflare Pages** or **GitHub Pages**.

---

## 2. What you need before you start

You'll need these installed on your computer:

| Tool | What it is | Where to get it |
| --- | --- | --- |
| **Node.js** (v20.19+ or v22.12+) | A "runtime" that lets JavaScript apps run on your computer | https://nodejs.org — download the **LTS** version |
| **npm** | A package manager that installs the project's dependencies | Comes automatically with Node.js |
| **Git** | The version-control tool GitHub is built on | https://git-scm.com/downloads |
| **A GitHub account** | You'll use this to sign in and access your repositories | https://github.com/join |

> **Check your versions.** Open a terminal (called "Command Prompt" on Windows, "Terminal" on macOS/Linux) and type:
>
> ```bash
> node --version
> npm --version
> git --version
> ```
>
> You should see version numbers like `v20.19.0`, `11.0.0`, and `2.43.0`. If a command isn't found, install that tool first.

---

## 3. Get the project files

First, you need a copy of the CMS code on your computer.

If you have the project already (for example, you cloned it), skip to step 4.

Otherwise, clone it from GitHub:

```bash
git clone <your-repository-url> cms
cd cms
```

> **Beginner note:** A terminal "clone" just downloads a copy of the project folder to your computer. The `cd cms` command moves you *into* that folder in the terminal.

---

## 4. Install the dependencies

The project uses **npm workspaces** — it's one big project made of three smaller packages that work together:

- `packages/frontend` — the web app you see in your browser
- `packages/backend` — a "Cloudflare Worker" that talks to GitHub securely
- `packages/shared` — shared code used by both

Run this from inside the `cms` folder:

```bash
npm install
```

This downloads all the libraries the project needs. It may take a minute or two the first time. When it finishes, you'll see a summary and the terminal will return to a prompt.

> **Beginner note:** If you ever see an `EACCES` or permission error here on macOS/Linux, it usually means npm was installed with `sudo`. Don't use `sudo npm install` — instead reinstall Node.js from the official installer, which avoids permission problems. On Windows, if you see an error about "Long paths", enable long paths in the Windows developer settings.

---

## 5. Create a GitHub OAuth App (so the CMS can sign you in)

The CMS signs you in through GitHub's secure "OAuth" flow. You need to create a small GitHub app that identifies the CMS and tells GitHub which permissions it needs.

> **Beginner note:** The safest way to try this is to create a **separate test repository** with an HTML file in it first (for example, `my-site` with `index.html`), so you don't risk touching a project you care about.

### Step 5.1 — Create a test site on GitHub (optional but recommended)

1. Go to https://github.com/new
2. Name it something like `my-site`.
3. Check **Add a README file** (this creates the repo with content).
4. Click **Create repository**.
5. On the repo page, click **Add file → Create new file**.
6. Name it `index.html` and paste this:

   ```html
   <!DOCTYPE html>
   <html lang="en">
   <head>
     <meta charset="UTF-8" />
     <title>My Website</title>
   </head>
   <body>
     <h1>Hello, world!</h1>
     <p>This is my first website.</p>
   </body>
   </html>
   ```

7. Click **Commit new file**.

Now you have a real static site with one page you can edit with the CMS.

### Step 5.2 — Register the OAuth app

1. Go to **https://github.com/settings/developers**
2. Click **New OAuth App**.
3. Fill in:
   - **Application name:** `Nomad CMS (local)`
   - **Homepage URL:** `http://localhost:5173`
   - **Authorization callback URL:** `http://localhost:5173/auth/callback`
4. Click **Register application**.
5. On the next page, you'll see the **Client ID** — copy it somewhere safe. This value is **public** (you'll set it as the backend's `GITHUB_CLIENT_ID` variable in step 6.3).
6. Click **Generate a new client secret**, then copy the secret. This value is **private** — never share it and never commit it to a repository.

> **Why these URLs?** During development, the CMS runs on your computer at `localhost:5173`. The "callback" is the page GitHub redirects your browser to after you approve the login.

---

## 6. Configure the project

The project stores its settings in two small files. Neither file is committed to the repository (they're gitignored), so you'll create them from the example files.

### Step 6.1 — Frontend configuration

Create a file called `.env.local` in the `packages/frontend` folder, based on the example:

```bash
cp packages/frontend/.env.example packages/frontend/.env.local
```

The example file contains only public values, and the defaults work as-is for local development:

```dotenv
# Base URL of the API. Empty means same-origin (dev proxy to Worker).
VITE_API_BASE_URL=

# Application name shown in the UI.
VITE_APP_NAME=Nomad CMS
```

> **Beginner note:** There is **no GitHub configuration in the frontend**. The GitHub sign-in link is built by the backend Worker — the frontend just asks it for the sign-in URL (`GET /api/auth/authorize`) and redirects your browser there.

> **Beginner note:** On Windows, the `cp` command might not exist. Instead, open the `.env.example` file in your editor, select all, copy, create a new file called `.env.local` in the same folder, and paste.

### Step 6.2 — Backend configuration

Create a file called `.dev.vars` in the `packages/backend` folder:

```bash
cp packages/backend/.dev.vars.example packages/backend/.dev.vars
```

Open `packages/backend/.dev.vars` and set your GitHub client secret and a session encryption key:

```dotenv
# GitHub OAuth client secret. SECRET.
GITHUB_CLIENT_SECRET=your_client_secret_here

# AES-256 key encrypting session data at rest. SECRET.
# Generate one with:  openssl rand -base64 32
SESSION_ENCRYPTION_KEY=your_generated_key_here
```

> - Replace `your_client_secret_here` with the secret from step 5.2.
> - For `SESSION_ENCRYPTION_KEY`, run `openssl rand -base64 32` in your terminal and paste the output. The CMS encrypts GitHub tokens with this key, so it is required.

### Step 6.3 — Set the backend's public variables

Open `packages/backend/wrangler.toml` and check these lines in the `[vars]` section (the checked-in file carries the production values, e.g. `https://nomad-cms.isseyshiitake.workers.dev/auth/callback`; for local development set them to your own app's values):

```toml
[vars]
GITHUB_CLIENT_ID = "YOUR_CLIENT_ID"
GITHUB_REDIRECT_URI = "http://localhost:5173/auth/callback"
OPERATOR_LOGIN = "your-github-username"
```

Set `GITHUB_CLIENT_ID` to your Client ID from step 5.2, and leave the redirect URI as `http://localhost:5173/auth/callback` for local development.

**`OPERATOR_LOGIN` matters:** the CMS pins ONE GitHub login as the operator (admin). Set it to your own username BEFORE your first sign-in — every other GitHub login is rejected with `403 instance_locked`. If you leave it empty, the first login claims the slot (write-once). The checked-in file pins the project owner's login; replace it with yours.

> **Where does the Client ID live?** Only in the backend. The Worker uses the Client ID **and** the secret to build the GitHub sign-in URL and exchange the authorization code for a GitHub access token. The frontend never sees either — it just asks the Worker for the sign-in URL (`GET /api/auth/authorize`) and redirects your browser there.

---

## 7. Run the CMS locally

The project runs two servers at the same time:

- The **backend** Worker on port `8787` (handles GitHub API calls and sign-in securely)
- The **frontend** on port `5173` (the app you see in your browser)

You'll need **two terminal windows**.

### Terminal 1 — start the backend

```bash
npm run dev:backend
```

Wait until you see output like `Ready on http://localhost:8787` or similar. Leave this terminal running.

### Terminal 2 — start the frontend

```bash
npm run dev:frontend
```

Wait until you see output like `Local: http://localhost:5173/`. Leave this running too.

### Open the app

In your browser, go to:

```
http://localhost:5173
```

---

## 8. Use the CMS

Now the fun part — let's walk through editing your test site.

### Step 8.1 — Sign in

1. On the Repositories page, click **Sign in with GitHub**.
2. GitHub will ask you to authorize the app. Review the permissions and click **Authorize**.
3. You'll be redirected back to the CMS, signed in.

### Step 8.2 — Open a repository

1. On the **Repositories** page, you'll see a list of repositories your account can access. Find `my-site` (your test repo).
2. Click it.

### Step 8.3 — Find and open a page

1. The **Pages** page shows a list of HTML files found in the repository (the "HTML files" panel) and the repository's folder structure (the "Repository contents" panel).
2. You should see `index.html` in the **HTML files** list. Click it.

> **Beginner note:** The HTML scanner looks for headings (`h1`, `h2`), paragraphs (`p`), images (`img`), and any element with a `data-editable` or `data-editable-block` attribute. Those are the things you can edit.

### Step 8.4 — Edit a page

You're now in the **Editor**. The screen has two columns:

- **Elements** (left) — the editable pieces of the page, each with controls
- **Live preview** (right) — a sandboxed iframe showing the current state of the page

Try these:

- **Edit text** — click into an element's text field and type. There's no "save edit" button: the change is applied in the editor immediately, and the **Live preview** reflects it as you type. For example, change "Hello, world!" to "Welcome to my site!".
- **Insert an element** — pick a tag (`h1`, `h2`, `p`, or `img`) from the dropdown, then click **Insert above** or **Insert below** to place it relative to an existing element.
- **Delete an element** — click **Delete** and confirm in the dialog that appears.
- **Replace an image** — if your page had images, you could type a new URL into the **Image src** field, or pick a local file to upload (the file is committed when you save).

Watch the **Live preview** update as you make changes. You can also undo the last change with the **Undo** button.

### Step 8.5 — Save your changes

1. The **Save** button becomes enabled once you have unsaved changes (you'll also see an "Unsaved changes" status).
2. Click **Save**.
3. The CMS commits the updated HTML back to GitHub with a message like `CMS: Updated index.html`.

To confirm, go to your `my-site` repository on GitHub, open `index.html`, and look at the file history — you should see the commit from the CMS.

---

## 9. Useful development commands

Here are the commands you'll use most often, all run from the `cms` folder:

| Command | What it does |
| --- | --- |
| `npm run dev:backend` | Starts the backend Worker (port 8787) |
| `npm run dev:frontend` | Starts the frontend dev server (port 5173) |
| `npm run build` | Builds all three packages for production |
| `npm run typecheck` | Checks the TypeScript types across all packages |
| `npm test` | Runs the automated tests |
| `npm run build:frontend` | Builds only the frontend |
| `npm run build:backend` | Builds only the backend |

> **Beginner note:** It's completely normal that the terminal "hangs" while a dev server is running — that means the server is up and watching for changes. Press `Ctrl + C` in a terminal to stop that server.

---

## 10. Troubleshooting

### "Sign in with GitHub" does nothing, or I get an error about a redirect URI

- Make sure the redirect URI in GitHub's OAuth app settings matches `GITHUB_REDIRECT_URI` in `packages/backend/wrangler.toml` **exactly** (including `http://` and the port).
- After changing `wrangler.toml` or `.dev.vars`, **restart** the backend dev server (stop it with `Ctrl + C`, then run `npm run dev:backend` again).

### The page lists "No repositories found"

- Make sure both dev servers are running and you restarted the backend after editing `wrangler.toml` or `.dev.vars`.
- Check that the backend terminal isn't showing an error, and that the GitHub OAuth app was granted the `repo` scope.

### "Failed to load the page for editing."

- Make sure the file is actually a `.html` file and exists in the repository.
- Check the backend terminal for errors.

### The editor shows "No editable elements found."

- The page has no `h1`, `h2`, `p`, `img`, or `data-editable` / `data-editable-block` elements. Add at least one of those to your HTML file.

### Port 5173 or 8787 is already in use

- Something else is using that port. Stop the other program, or change the port (frontend port is in `packages/frontend/vite.config.ts`; backend port is set by wrangler).

### npm install fails

- Make sure you're using Node v20.19+ or v22.12+ (`node --version`).
- Delete `node_modules` and `package-lock.json` inside the `cms` folder, then run `npm install` again.

---

## 11. Next steps

Once you're comfortable with the basics here, you may want to:

- **Edit a real project** — your own static site repository.
- **Mark specific elements as editable** — add a `data-editable` attribute to any HTML element (e.g. `<div data-editable>…</div>`) so the CMS exposes it in the editor. Use `data-editable-block` to mark a larger container (such as a card or section) as editable in its own right.
- **Deploy to production** — see:
  - `docs/deployment.md` — end-to-end production deployment
  - `docs/github-app.md` — detailed GitHub OAuth configuration
  - `docs/cloudflare-worker.md` — Cloudflare Worker setup
  - `docs/static-assets.md` — how the Worker serves the frontend's static assets
  - `docs/production-checklist.md` — pre/post-deploy checklist
- **Read about the architecture** — `docs/architecture.md` explains how the frontend, backend, and shared packages fit together and why credentials never reach the browser.

---

## Quick reference: project layout

```
cms/
├── package.json              # Root config: scripts, workspaces, overrides
├── packages/
│   ├── frontend/             # React app (what you see in the browser)
│   │   ├── .env.example      # Example frontend config
│   │   └── src/
│   │       ├── api/          # Typed HTTP client
│   │       ├── features/     # Pages: repositories, pages, editor, settings
│   │       ├── services/     # Auth, HTML parser, editor state, images
│   │       └── ui/           # Reusable layout and components
│   ├── backend/              # Cloudflare Worker API (holds all secrets)
│   │   ├── .dev.vars.example # Example local secrets
│   │   ├── wrangler.toml     # Worker config
│   │   └── src/
│   │       ├── routes/       # API endpoints
│   │       └── services/     # GitHub API client + OAuth session
│   └── shared/               # Types shared by frontend and backend
└── docs/                     # Detailed guides (deployment, GitHub, etc.)