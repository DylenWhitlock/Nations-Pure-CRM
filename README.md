# Nation's Pure Leads — standalone setup

This is the same CRM, rebuilt to run on your own domain instead of through Claude.
It's a plain website (`index.html` + a few static files) backed by Supabase (free tier)
for the database, file storage, and staff logins.

Total setup time: about 15 minutes, one time. After that, I can keep making changes for
you and they'll go live automatically — no setup steps repeat.

## 1. Create your Supabase project (~5 min)

1. Go to supabase.com and sign up (free — no card required for the free tier).
2. Click **New project**. Name it whatever you like (e.g. "nations-pure-crm"). Pick a
   database password and region (US region closest to DFW, e.g. `us-east-1`), then create it.
3. Once it's ready, go to **SQL Editor** (left sidebar) → **New query**.
4. Open `supabase-schema.sql` from this folder, copy all of it, paste it into the query
   box, and click **Run**. This creates the tables, turns on live updates, and sets up
   private file storage for brochures and work orders. You only do this once.
5. Go to **Project Settings → API**. Copy the **Project URL** and the **anon public** key.
6. Open `config.js` in this folder and paste those two values in where marked.

## 2. Add your team as logins (~2 min)

By default Supabase lets anyone sign themselves up — turn that off so only your team can get in:

1. **Authentication → Providers → Email** → turn off "Allow new users to sign up".
2. **Authentication → Users → Add user → Create new user**. Add Cara, Chris, yourself,
   and anyone else who needs access — enter their email, set a temporary password (or
   check "auto confirm" and use "Send invite" if you'd rather they set their own).
3. Give each person their email + password. They can sign in and change their password
   any time via "Forgot password?" on the login screen.

## 3. Put it on the web with your own domain (~5 min)

1. Go to vercel.com and sign up with GitHub (free).
2. Create a new GitHub repo (e.g. `nations-pure-crm`) and push this whole folder to it —
   or just drag-and-drop the folder into a new Vercel project if you don't want to deal
   with git at all (Vercel supports both).
3. In Vercel, "Import" that repo/folder as a new project and deploy it — takes under a
   minute. You'll get a free `*.vercel.app` link immediately.
4. To use your own domain (e.g. `crm.nationspure.com`): in the Vercel project, go to
   **Settings → Domains**, add it, and Vercel will give you a DNS record to add wherever
   your domain is managed (GoDaddy, Squarespace, etc.) — usually a CNAME record. Once
   that propagates (minutes to a few hours), your domain points straight at the CRM.

## After setup: making changes

Send me what you want changed, same as always. If this is connected to GitHub, I update
the code and push it — Vercel redeploys automatically in under a minute, no action needed
from you. If you went the drag-and-drop route instead, I'll hand you an updated folder to
re-drop into Vercel each time.

## What's different from the Claude version

- Real logins — each teammate signs in with their own email/password.
- Your data lives in your own Supabase database, not Claude's.
- Work orders and brochures are stored privately (only signed-in teammates can open the links).
- Everything else — the lead board, the calendar/scheduling, notes, the fillable work
  order with signatures — works exactly the same.
