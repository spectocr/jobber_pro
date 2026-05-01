/**
 * Gmail API Email Service
 * Handles sending emails via Gmail API with OAuth2
 */

const { google } = require('googleapis');
const nodemailer = require('nodemailer');

class EmailService {
    constructor() {
        this.oauth2Client = null;
        this.gmail = null;
        this.transporter = null;
        this.initialized = false;
    }

    /**
     * Initialize Gmail API with OAuth2 credentials
     * Required environment variables:
     * - GMAIL_CLIENT_ID
     * - GMAIL_CLIENT_SECRET
     * - GMAIL_REFRESH_TOKEN
     * - GMAIL_USER (email address to send from)
     */
    async initialize() {
        // Reset state first
        this.initialized = false;
        this.oauth2Client = null;
        this.gmail = null;
        this.transporter = null;

        try {
            const clientId = process.env.GMAIL_CLIENT_ID;
            const clientSecret = process.env.GMAIL_CLIENT_SECRET;
            const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
            const userEmail = process.env.GMAIL_USER;

            if (!clientId || !clientSecret || !refreshToken || !userEmail) {
                console.warn('⚠️  Gmail API credentials not configured. Email functionality disabled.');
                console.warn('   Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_USER');
                return false;
            }

            // Create OAuth2 client
            this.oauth2Client = new google.auth.OAuth2(
                clientId,
                clientSecret,
                'https://developers.google.com/oauthplayground' // Redirect URI
            );

            this.oauth2Client.setCredentials({
                refresh_token: refreshToken
            });

            // Initialize Gmail API
            this.gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });

            // Create Nodemailer transporter using Gmail OAuth2
            const accessToken = await this.oauth2Client.getAccessToken();

            this.transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: {
                    type: 'OAuth2',
                    user: userEmail,
                    clientId: clientId,
                    clientSecret: clientSecret,
                    refreshToken: refreshToken,
                    accessToken: accessToken.token
                }
            });

            this.initialized = true;
            console.log('✅ Gmail API initialized successfully');
            return true;

        } catch (error) {
            console.error('❌ Failed to initialize Gmail API:', error.message);
            return false;
        }
    }

    /**
     * Send email using Gmail API
     */
    async sendEmail({ to, subject, html, text, attachments = [] }) {
        if (!this.initialized) {
            const error = new Error('Email service not initialized. Check Gmail API credentials in Settings > Email Settings.');
            console.error('❌ Email not initialized. Env vars:', {
                hasClientId: !!process.env.GMAIL_CLIENT_ID,
                hasClientSecret: !!process.env.GMAIL_CLIENT_SECRET,
                hasRefreshToken: !!process.env.GMAIL_REFRESH_TOKEN,
                hasUser: !!process.env.GMAIL_USER
            });
            throw error;
        }

        try {
            const mailOptions = {
                from: `"Jobber Pro" <${process.env.GMAIL_USER}>`,
                to: to,
                subject: subject,
                text: text,
                html: html,
                attachments: attachments,
                headers: {
                    'X-Priority': '3',
                    'X-Mailer': 'Jobber Pro',
                    'Importance': 'Normal'
                }
            };

            const result = await this.transporter.sendMail(mailOptions);
            console.log('✅ Email sent to:', to, 'Message ID:', result.messageId);
            return { success: true, messageId: result.messageId };

        } catch (error) {
            console.error('❌ Failed to send email to:', to, 'Error:', error.message);
            throw error;
        }
    }

    /**
     * Send user sign-on credentials
     */
    async sendUserCredentials({ to, name, email, tempPassword, companyName, loginUrl }) {
        const subject = `Your ${companyName} Account Credentials`;

        const html = `
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #667eea; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border: 1px solid #ddd; border-radius: 0 0 8px 8px; }
        .credentials { background: white; padding: 20px; border-left: 4px solid #667eea; margin: 20px 0; }
        .button { display: inline-block; padding: 12px 30px; background: #667eea; color: white; text-decoration: none; border-radius: 6px; margin: 20px 0; }
        .footer { text-align: center; color: #888; font-size: 12px; margin-top: 30px; }
        code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-family: monospace; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Welcome to ${companyName}</h1>
        </div>
        <div class="content">
            <p>Hi ${name},</p>
            <p>Your account has been created! You can now access the ${companyName} system.</p>

            <div class="credentials">
                <h3>Your Login Credentials:</h3>
                <p><strong>Email:</strong> <code>${email}</code></p>
                <p><strong>Temporary Password:</strong> <code>${tempPassword}</code></p>
            </div>

            <p><strong>⚠️ Important:</strong> Please change your password after logging in for the first time.</p>

            <a href="${loginUrl}" class="button">Login Now</a>

            <p>If you have any questions or need assistance, please don't hesitate to contact us.</p>
        </div>
        <div class="footer">
            <p>This is an automated message from ${companyName}</p>
            <p>Please do not reply to this email.</p>
        </div>
    </div>
</body>
</html>
        `;

        const text = `
Welcome to ${companyName}!

Your account has been created. Here are your login credentials:

Email: ${email}
Temporary Password: ${tempPassword}

Login at: ${loginUrl}

IMPORTANT: Please change your password after logging in for the first time.

If you have any questions, please contact us.

---
This is an automated message from ${companyName}
        `.trim();

        return this.sendEmail({ to, subject, html, text });
    }

    /**
     * Send invoice to client
     */
    async sendInvoice({ to, clientName, invoiceNumber, jobTitle, total, invoiceUrl, pdfBuffer, companyName }) {
        const subject = `Invoice #${invoiceNumber} from ${companyName}`;

        const html = `
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #667eea; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border: 1px solid #ddd; border-radius: 0 0 8px 8px; }
        .invoice-box { background: white; padding: 20px; border-left: 4px solid #48bb78; margin: 20px 0; }
        .invoice-box h3 { margin-top: 0; color: #48bb78; }
        .total { font-size: 1.5em; font-weight: bold; color: #667eea; margin: 10px 0; }
        .button { display: inline-block; padding: 12px 30px; background: #667eea; color: white; text-decoration: none; border-radius: 6px; margin: 20px 0; }
        .footer { text-align: center; color: #888; font-size: 12px; margin-top: 30px; }
        .note { background: #fffacd; padding: 15px; border-left: 4px solid #f59e0b; margin: 20px 0; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📄 Invoice from ${companyName}</h1>
        </div>
        <div class="content">
            <p>Dear ${clientName},</p>
            <p>Thank you for your business! Your invoice is ready for review.</p>

            <div class="invoice-box">
                <h3>Invoice Details</h3>
                <p><strong>Invoice Number:</strong> ${invoiceNumber}</p>
                <p><strong>Job:</strong> ${jobTitle}</p>
                <p><strong>Total Amount:</strong> <span class="total">$${parseFloat(total).toFixed(2)}</span></p>
            </div>

            ${invoiceUrl ? `<a href="${invoiceUrl}" class="button">View Invoice Online</a>` : ''}

            <div class="note">
                <strong>💡 Payment Information:</strong><br>
                Please reference Invoice #${invoiceNumber} when making payment.
            </div>

            <p>If you have any questions about this invoice, please don't hesitate to contact us.</p>

            <p>Thank you for choosing ${companyName}!</p>
        </div>
        <div class="footer">
            <p>${companyName}</p>
            <p>This is an automated invoice notification</p>
        </div>
    </div>
</body>
</html>
        `;

        const text = `
Invoice from ${companyName}

Dear ${clientName},

Thank you for your business! Your invoice is ready for review.

Invoice Details:
- Invoice Number: ${invoiceNumber}
- Job: ${jobTitle}
- Total Amount: $${parseFloat(total).toFixed(2)}

${invoiceUrl ? `View online: ${invoiceUrl}` : ''}

Payment Information:
Please reference Invoice #${invoiceNumber} when making payment.

If you have any questions, please contact us.

Thank you for choosing ${companyName}!

---
${companyName}
        `.trim();

        const attachments = [];
        if (pdfBuffer) {
            attachments.push({
                filename: `Invoice-${invoiceNumber}.pdf`,
                content: pdfBuffer,
                contentType: 'application/pdf'
            });
        }

        return this.sendEmail({ to, subject, html, text, attachments });
    }

    /**
     * Test email configuration
     */
    async sendTestEmail(to) {
        const subject = 'Jobber Pro Email Test';
        const html = `
            <h2>✅ Email Configuration Test</h2>
            <p>If you're reading this, your Gmail API integration is working correctly!</p>
            <p>You can now send:</p>
            <ul>
                <li>User credentials to new team members</li>
                <li>Invoices to clients</li>
                <li>Other automated notifications</li>
            </ul>
        `;
        const text = 'Email configuration test successful! Gmail API is working correctly.';

        return this.sendEmail({ to, subject, html, text });
    }
}

// Export singleton instance
module.exports = new EmailService();
