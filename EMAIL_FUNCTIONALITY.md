# Email Functionality Summary

## What's Been Added

Gmail API integration for sending professional emails from your Jobber Pro app.

## Features

### 1. User Credential Emails
Send login credentials to new team members automatically
- Professional HTML template
- Includes temp password and login link
- Company branding

### 2. Invoice Emails  
Send invoices to clients via email
- Beautiful HTML invoice notification
- Option to attach PDF (ready for future implementation)
- Invoice details and payment info
- Direct link to view invoice online

### 3. Test Emails
Verify your email configuration is working

## API Endpoints

### Test Email
```bash
POST /api/email/test
{
  "to": "test@example.com"
}
```

### Send User Credentials
```bash
POST /api/email/send-credentials
{
  "userId": "user-mongodb-id"
}
```

### Send Invoice
```bash
POST /api/email/send-invoice
{
  "jobId": "job-mongodb-id"
}
```

## Setup Required

**Before deploying, you MUST set up Gmail API credentials:**

1. Follow the complete setup guide in `GMAIL_SETUP.md`
2. Get OAuth2 credentials from Google Cloud Console
3. Set environment variables:
   - `GMAIL_CLIENT_ID`
   - `GMAIL_CLIENT_SECRET`  
   - `GMAIL_REFRESH_TOKEN`
   - `GMAIL_USER`

### Quick Heroku Setup

```bash
heroku config:set GMAIL_CLIENT_ID="your-id.apps.googleusercontent.com"
heroku config:set GMAIL_CLIENT_SECRET="your-secret"
heroku config:set GMAIL_REFRESH_TOKEN="your-token"
heroku config:set GMAIL_USER="youremail@gmail.com"
```

## What Happens If Not Configured

- Server starts normally
- You'll see: `⚠️  Gmail API credentials not configured`
- Email endpoints will return errors
- Rest of app works fine

## Email Templates

All email templates are customizable in `email-service.js`:

- **User Credentials**: Welcome message with login info
- **Invoice**: Professional invoice notification with payment details
- **Test Email**: Configuration verification

Templates include:
- Company branding
- Responsive HTML design
- Plain text fallback
- Professional styling

## Next Steps

1. **Deploy to Heroku** (without email first)
2. **Set up Gmail API** following GMAIL_SETUP.md
3. **Configure environment variables** in Heroku
4. **Test email sending** using test endpoint
5. **Integrate into UI** - add "Email Invoice" buttons, etc.

## Future Enhancements

- PDF invoice attachments
- Payment reminder emails
- Appointment confirmation emails
- Email sending history/tracking
- Batch email sending
- Email templates in database (customizable per user)

## Files Added

- `email-service.js` - Core email service with Gmail OAuth2
- `GMAIL_SETUP.md` - Complete setup guide
- `EMAIL_FUNCTIONALITY.md` - This file
- `server.js` - Added email API endpoints
- `package.json` - Added googleapis and nodemailer

## Dependencies Added

```json
{
  "googleapis": "^144.0.0",
  "nodemailer": "^6.9.16"
}
```

These will be installed automatically when you deploy to Heroku.
