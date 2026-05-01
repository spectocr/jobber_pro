# Gmail API Setup Guide

This guide will help you set up Gmail API integration for Jobber Pro so you can send emails for user credentials and client invoices.

## Prerequisites

- A Google/Gmail account
- Access to Google Cloud Console

## Step 1: Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click **"Create Project"** or select an existing project
3. Give it a name like "Jobber Pro Email"
4. Click **Create**

## Step 2: Enable Gmail API

1. In your project, go to **"APIs & Services"** → **"Library"**
2. Search for **"Gmail API"**
3. Click on it and click **"Enable"**

## Step 3: Create OAuth2 Credentials

1. Go to **"APIs & Services"** → **"Credentials"**
2. Click **"Create Credentials"** → **"OAuth client ID"**
3. If prompted, configure the OAuth consent screen:
   - User Type: **External** (unless you have Google Workspace)
   - App name: **Jobber Pro**
   - User support email: Your email
   - Developer contact: Your email
   - Click **Save and Continue**
   - Skip Scopes (click **Save and Continue**)
   - Add your email as a test user
   - Click **Save and Continue**

4. Back to creating OAuth client ID:
   - Application type: **Web application**
   - Name: **Jobber Pro Email Client**
   - Authorized redirect URIs: Add these two:
     - `https://developers.google.com/oauthplayground`
     - `http://localhost` (for local testing)
   - Click **Create**

5. **Save the credentials:**
   - Copy the **Client ID** 
   - Copy the **Client Secret**
   - Keep these safe!

## Step 4: Get Refresh Token

1. Go to [OAuth 2.0 Playground](https://developers.google.com/oauthplayground)
2. Click the **Settings gear icon** (top right)
3. Check **"Use your own OAuth credentials"**
4. Enter your **Client ID** and **Client Secret**
5. Close settings

6. On the left side, find **"Gmail API v1"**
7. Select: `https://mail.google.com/` (full Gmail access)
8. Click **"Authorize APIs"**
9. Sign in with your Google account
10. Click **"Allow"** to grant permissions
11. Click **"Exchange authorization code for tokens"**
12. Copy the **Refresh token** that appears

## Step 5: Configure Environment Variables

Add these to your `.env` file or Heroku config vars:

```bash
# Gmail API Configuration
GMAIL_CLIENT_ID=your-client-id.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=your-client-secret
GMAIL_REFRESH_TOKEN=your-refresh-token
GMAIL_USER=your-email@gmail.com
```

### For Local Development (.env file):

```bash
GMAIL_CLIENT_ID=123456789.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=GOCSPX-AbCdEfGhIjKlMnOpQrStUvWx
GMAIL_REFRESH_TOKEN=1//0abcdefghijklmnopqrstuvwxyz
GMAIL_USER=youremail@gmail.com
```

### For Heroku:

```bash
heroku config:set GMAIL_CLIENT_ID="your-client-id.apps.googleusercontent.com"
heroku config:set GMAIL_CLIENT_SECRET="your-client-secret"
heroku config:set GMAIL_REFRESH_TOKEN="your-refresh-token"
heroku config:set GMAIL_USER="your-email@gmail.com"
```

Or use the Heroku Dashboard:
1. Go to your app → **Settings** → **Config Vars**
2. Click **Reveal Config Vars**
3. Add each variable

## Step 6: Test Email Functionality

Once configured, you can test the email system:

1. Start your server
2. You should see: `✅ Gmail API initialized successfully`
3. Use the test endpoint (see Usage section)

## Usage

### Send Test Email

```bash
# HTTP Request
POST /api/email/test
Content-Type: application/json

{
  "to": "recipient@example.com"
}
```

### Send User Credentials

```bash
POST /api/email/send-credentials
Content-Type: application/json

{
  "userId": "user-id-here"
}
```

### Send Invoice

```bash
POST /api/email/send-invoice
Content-Type: application/json

{
  "jobId": "job-id-here"
}
```

## Troubleshooting

### "Email service not initialized"
- Check that all 4 environment variables are set
- Verify the credentials are correct
- Check server logs for initialization errors

### "Invalid credentials"
- Regenerate the refresh token using OAuth Playground
- Make sure you selected the correct Gmail scope (`https://mail.google.com/`)

### "Access blocked"
- Make sure you added your email as a test user in OAuth consent screen
- For production use, you'll need to verify your app with Google

### "Quota exceeded"
- Gmail API has a daily sending limit
- Free tier: ~100 emails/day for new accounts, ~500/day for established accounts
- Consider upgrading to Google Workspace for higher limits

## Security Notes

1. **Never commit credentials to Git**
   - Add `.env` to `.gitignore`
   - Use Heroku config vars for production

2. **Refresh tokens don't expire** unless:
   - You revoke access
   - You change your Google password
   - 6 months of inactivity (for unverified apps)

3. **Keep credentials secure**
   - Store in environment variables only
   - Don't share them in chat/email
   - Rotate them if compromised

## Email Templates

The system includes pre-built templates for:
- ✅ User credential emails (sign-on info for new team members)
- ✅ Invoice emails (with PDF attachment)
- ✅ Test emails (to verify configuration)

Templates are fully customizable in `email-service.js`.

## Next Steps

After setup, you can:
1. Customize email templates in `email-service.js`
2. Add more email types (payment reminders, appointment confirmations, etc.)
3. Track email sending in your application logs
4. Add email history tracking to MongoDB

## Need Help?

Common issues and solutions:
- **Can't find OAuth Playground**: https://developers.google.com/oauthplayground
- **Need different scopes**: Select `https://mail.google.com/` for full Gmail access
- **Token expired**: Refresh tokens should not expire, but you can regenerate them
- **App not verified warning**: Normal for testing, can request verification from Google for production

---

For more information:
- [Gmail API Documentation](https://developers.google.com/gmail/api)
- [OAuth 2.0 Guide](https://developers.google.com/identity/protocols/oauth2)
- [Nodemailer Gmail OAuth2](https://nodemailer.com/smtp/oauth2/)
