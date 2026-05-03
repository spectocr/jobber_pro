/**
 * AWS SES Email Service
 * Sends transactional emails via AWS Simple Email Service
 */

const { SESClient, SendRawEmailCommand } = require('@aws-sdk/client-ses');
const nodemailer = require('nodemailer');

class EmailService {
    constructor() {
        this.transporter = null;
        this.fromEmail = null;
        this.fromName = null;
        this.initialized = false;
    }

    async initialize() {
        this.initialized = false;
        this.transporter = null;

        try {
            const accessKeyId = process.env.SES_ACCESS_KEY_ID;
            const secretAccessKey = process.env.SES_SECRET_ACCESS_KEY;
            const fromEmail = process.env.SES_FROM_EMAIL;
            const region = process.env.AWS_REGION || 'us-east-1';

            if (!accessKeyId || !secretAccessKey || !fromEmail) {
                console.warn('⚠️  AWS SES credentials not configured. Email functionality disabled.');
                console.warn('   Set SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY, SES_FROM_EMAIL');
                return false;
            }

            const sesClient = new SESClient({
                region,
                credentials: { accessKeyId, secretAccessKey }
            });

            this.transporter = nodemailer.createTransport({
                SES: { ses: sesClient, aws: { SendRawEmailCommand } }
            });

            this.fromEmail = fromEmail;
            this.fromName = process.env.SES_FROM_NAME || 'GSD Handyman Service';
            this.initialized = true;
            console.log(`✅ AWS SES initialized — sending from ${fromEmail}`);
            return true;

        } catch (error) {
            console.error('❌ Failed to initialize AWS SES:', error.message);
            return false;
        }
    }

    async sendEmail({ to, subject, html, text, attachments = [] }) {
        if (!this.initialized) {
            throw new Error('Email service not initialized. Check SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY, and SES_FROM_EMAIL in config.');
        }

        try {
            const result = await this.transporter.sendMail({
                from: `"${this.fromName}" <${this.fromEmail}>`,
                to,
                subject,
                text,
                html,
                attachments
            });
            console.log('✅ Email sent to:', to, 'Message ID:', result.messageId);
            return { success: true, messageId: result.messageId };
        } catch (error) {
            console.error('❌ Failed to send email to:', to, 'Error:', error.message);
            throw error;
        }
    }

    replaceVariables(template, variables) {
        let result = template;
        for (const [key, value] of Object.entries(variables)) {
            const regex = new RegExp(`\\{${key}\\}`, 'g');
            result = result.replace(regex, value);
        }
        return result;
    }

    async sendUserCredentials({ to, name, email, tempPassword, companyName, loginUrl, customSubject, customBody }) {
        const subjectTemplate = customSubject || `Your {companyName} Account Credentials`;
        const bodyTemplate = customBody || `Hi {name},\n\nYour account has been created!\n\nEmail: {email}\nTemporary Password: {tempPassword}\n\nLogin at: {loginUrl}\n\nPlease change your password after logging in.`;

        const variables = { name, email, tempPassword, companyName, loginUrl };
        const subject = this.replaceVariables(subjectTemplate, variables);
        const textBody = this.replaceVariables(bodyTemplate, variables);

        const html = `<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #667eea; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border: 1px solid #ddd; border-radius: 0 0 8px 8px; }
        .footer { text-align: center; color: #888; font-size: 12px; margin-top: 30px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header"><h1>Welcome to ${companyName}</h1></div>
        <div class="content">
            <div style="white-space: pre-wrap; line-height: 1.6;">${textBody.replace(/\n/g, '<br>')}</div>
        </div>
        <div class="footer">
            <p>This is an automated message from ${companyName}</p>
        </div>
    </div>
</body>
</html>`;

        return this.sendEmail({ to, subject, html, text: textBody });
    }

    async sendInvoice({ to, clientName, invoiceNumber, jobTitle, total, invoiceUrl, pdfBuffer, companyName, customSubject, customBody }) {
        const subjectTemplate = customSubject || `Invoice #{invoiceNumber} from {companyName}`;
        const bodyTemplate = customBody || `Dear {clientName},\n\nThank you for your business! Your invoice is ready.\n\nInvoice #{invoiceNumber}\nJob: {jobTitle}\nTotal: $${parseFloat(total).toFixed(2)}\n\nView your invoice: {invoiceUrl}\n\nThank you for choosing {companyName}!`;

        const variables = { clientName, invoiceNumber, jobTitle, total: parseFloat(total).toFixed(2), invoiceUrl, companyName };
        const subject = this.replaceVariables(subjectTemplate, variables);
        const textBody = this.replaceVariables(bodyTemplate, variables);

        const html = `<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #667eea; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border: 1px solid #ddd; border-radius: 0 0 8px 8px; }
        .footer { text-align: center; color: #888; font-size: 12px; margin-top: 30px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header"><h1>Invoice from ${companyName}</h1></div>
        <div class="content">
            <div style="white-space: pre-wrap; line-height: 1.6;">${textBody.replace(/\n/g, '<br>')}</div>
        </div>
        <div class="footer"><p>${companyName}</p></div>
    </div>
</body>
</html>`;

        const attachments = [];
        if (pdfBuffer) {
            attachments.push({
                filename: `Invoice-${invoiceNumber}.pdf`,
                content: pdfBuffer,
                contentType: 'application/pdf'
            });
        }

        return this.sendEmail({ to, subject, html, text: textBody, attachments });
    }

    async sendTestEmail(to) {
        return this.sendEmail({
            to,
            subject: 'GSD Handyman Service — Email Test',
            html: `<h2>✅ Email Test Successful</h2><p>AWS SES is configured and sending correctly from ${this.fromEmail}.</p>`,
            text: `Email test successful. AWS SES is sending correctly from ${this.fromEmail}.`
        });
    }
}

module.exports = new EmailService();
