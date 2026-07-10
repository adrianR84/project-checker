# Google OAuth Setup for Project Checker

## Step 1 — Create a Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Sign in with your Google account
3. Top-left dropdown → **"Select project"** → **"New project"**
4. Name it (e.g. `project-checker`) → click **Create**

---

## Step 2 — Enable the Google+ API

1. In the sidebar: **APIs & Services → Library**
2. Search for **"Google+"** (or **"Google Identity"**)
3. Click **Google+ API** → **Enable**

---

## Step 3 — Configure the OAuth consent screen

1. **APIs & Services → OAuth consent screen**
2. Choose **External** → **Create**
3. Fill in:
   - App name: `Project Checker`
   - User support email: your Gmail address
   - Developer contact: your Gmail address
4. Click **Save and Continue** → **Skip scopes** → **Save and Continue** again
5. Add your Gmail as a **Test user** (required before prod publish)

---

## Step 4 — Create OAuth 2.0 credentials

1. **APIs & Services → Credentials**
2. Click **+ Create Credentials** → **OAuth client ID**
3. Application type: **Web application**
4. **Authorized redirect URIs** → Add:
   ```
   http://localhost:3000/api/auth/callback/google
   ```
   (add your production URL too once deployed, e.g. `https://your-domain.com/api/auth/callback/google`)
5. Click **Create**
6. Copy the **Client ID** and **Client Secret**

---

## Step 5 — Add to `.env`

```env
BETTER_AUTH_URL=http://localhost:3000
GOOGLE_CLIENT_ID=<the Client ID you just copied>
GOOGLE_CLIENT_SECRET=<the Client Secret you just copied>
```

For production, set `BETTER_AUTH_URL=https://your-domain.com` and add the production redirect URI to the Google Console credential as well.

---

## What each value does

| Variable | Purpose |
|---|---|
| `BETTER_AUTH_URL` | Tells better-auth where your app lives so Google knows where to redirect after login |
| `GOOGLE_CLIENT_ID` | Public ID that identifies your app in the Google sign-in dialog |
| `GOOGLE_CLIENT_SECRET` | Secret key your server uses to verify the OAuth callback is genuine |
