/**
 * Google Calendar API Service
 * Handles calendar events and sync with Google Calendar
 */

const { google } = require('googleapis');

class CalendarService {
    constructor() {
        this.oauth2Client = null;
        this.calendar = null;
        this.initialized = false;
        this.calendarId = null; // Will use 'primary' or specific calendar ID
    }

    /**
     * Initialize Google Calendar API with OAuth2 credentials
     * Uses same credentials as Gmail API
     */
    async initialize() {
        this.initialized = false;
        this.oauth2Client = null;
        this.calendar = null;

        try {
            const clientId = process.env.GMAIL_CLIENT_ID;
            const clientSecret = process.env.GMAIL_CLIENT_SECRET;
            const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
            const userEmail = process.env.GMAIL_USER;

            if (!clientId || !clientSecret || !refreshToken || !userEmail) {
                console.warn('⚠️  Google Calendar API credentials not configured. Calendar functionality disabled.');
                return false;
            }

            // Create OAuth2 client (same as Gmail)
            this.oauth2Client = new google.auth.OAuth2(
                clientId,
                clientSecret,
                'https://developers.google.com/oauthplayground'
            );

            this.oauth2Client.setCredentials({
                refresh_token: refreshToken
            });

            // Initialize Calendar API
            this.calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });

            // Use primary calendar by default
            this.calendarId = 'primary';

            this.initialized = true;
            console.log('✅ Google Calendar API initialized successfully');
            return true;

        } catch (error) {
            console.error('❌ Failed to initialize Google Calendar API:', error.message);
            return false;
        }
    }

    /**
     * Create calendar event for a job
     */
    async createJobEvent({ job, client, companyName, sendInvite = false }) {
        if (!this.initialized) {
            throw new Error('Calendar service not initialized. Check Google Calendar API credentials in Settings.');
        }

        try {
            // Parse date and time
            const scheduledDate = job.scheduledDate; // YYYY-MM-DD
            const scheduledTime = job.scheduledTime || '09:00'; // HH:MM

            // Create ISO datetime strings
            const startDateTime = `${scheduledDate}T${scheduledTime}:00`;

            // Default duration: 2 hours if not specified
            const durationHours = job.estimatedHours || 2;
            const endDate = new Date(startDateTime);
            endDate.setHours(endDate.getHours() + durationHours);
            const endDateTime = endDate.toISOString().split('.')[0];

            // Build event description
            let description = `Job: ${job.title}\n`;
            if (job.description) description += `\nDescription: ${job.description}\n`;
            if (client) {
                description += `\nClient: ${client.name}`;
                if (client.phone) description += `\nPhone: ${client.phone}`;
                if (client.email) description += `\nEmail: ${client.email}`;
                if (client.address) description += `\nAddress: ${client.address}`;
            }
            if (job.assignedToName) description += `\nAssigned to: ${job.assignedToName}`;
            description += `\n\nStatus: ${job.status}`;

            // Event object
            const event = {
                summary: `${companyName}: ${job.title}`,
                location: client?.address || '',
                description: description,
                start: {
                    dateTime: startDateTime,
                    timeZone: 'America/New_York', // TODO: Make configurable
                },
                end: {
                    dateTime: endDateTime,
                    timeZone: 'America/New_York',
                },
                colorId: '9', // Blue color
                reminders: {
                    useDefault: false,
                    overrides: [
                        { method: 'email', minutes: 24 * 60 }, // 1 day before
                        { method: 'popup', minutes: 60 }, // 1 hour before
                    ],
                },
            };

            // Add client as attendee if sending invite
            if (sendInvite && client?.email) {
                event.attendees = [
                    { email: client.email, displayName: client.name }
                ];
                event.guestsCanModify = false;
                event.guestsCanInviteOthers = false;
                event.guestsCanSeeOtherGuests = false;
            }

            const response = await this.calendar.events.insert({
                calendarId: this.calendarId,
                resource: event,
                sendUpdates: sendInvite ? 'all' : 'none', // Send email invites if requested
            });

            console.log('✅ Calendar event created:', response.data.id);
            return {
                success: true,
                eventId: response.data.id,
                eventLink: response.data.htmlLink,
                hangoutLink: response.data.hangoutLink
            };

        } catch (error) {
            console.error('❌ Failed to create calendar event:', error.message);
            throw error;
        }
    }

    /**
     * Update existing calendar event
     */
    async updateJobEvent({ eventId, job, client, companyName, sendUpdate = false }) {
        if (!this.initialized) {
            throw new Error('Calendar service not initialized.');
        }

        try {
            // Parse date and time
            const scheduledDate = job.scheduledDate;
            const scheduledTime = job.scheduledTime || '09:00';
            const startDateTime = `${scheduledDate}T${scheduledTime}:00`;

            const durationHours = job.estimatedHours || 2;
            const endDate = new Date(startDateTime);
            endDate.setHours(endDate.getHours() + durationHours);
            const endDateTime = endDate.toISOString().split('.')[0];

            let description = `Job: ${job.title}\n`;
            if (job.description) description += `\nDescription: ${job.description}\n`;
            if (client) {
                description += `\nClient: ${client.name}`;
                if (client.phone) description += `\nPhone: ${client.phone}`;
                if (client.email) description += `\nEmail: ${client.email}`;
                if (client.address) description += `\nAddress: ${client.address}`;
            }
            if (job.assignedToName) description += `\nAssigned to: ${job.assignedToName}`;
            description += `\n\nStatus: ${job.status}`;

            const event = {
                summary: `${companyName}: ${job.title}`,
                location: client?.address || '',
                description: description,
                start: {
                    dateTime: startDateTime,
                    timeZone: 'America/New_York',
                },
                end: {
                    dateTime: endDateTime,
                    timeZone: 'America/New_York',
                },
            };

            const response = await this.calendar.events.update({
                calendarId: this.calendarId,
                eventId: eventId,
                resource: event,
                sendUpdates: sendUpdate ? 'all' : 'none',
            });

            console.log('✅ Calendar event updated:', response.data.id);
            return { success: true, eventId: response.data.id };

        } catch (error) {
            console.error('❌ Failed to update calendar event:', error.message);
            throw error;
        }
    }

    /**
     * Delete calendar event
     */
    async deleteJobEvent(eventId, sendUpdate = false) {
        if (!this.initialized) {
            throw new Error('Calendar service not initialized.');
        }

        try {
            await this.calendar.events.delete({
                calendarId: this.calendarId,
                eventId: eventId,
                sendUpdates: sendUpdate ? 'all' : 'none',
            });

            console.log('✅ Calendar event deleted:', eventId);
            return { success: true };

        } catch (error) {
            console.error('❌ Failed to delete calendar event:', error.message);
            throw error;
        }
    }

    /**
     * Get event by ID
     */
    async getEvent(eventId) {
        if (!this.initialized) {
            throw new Error('Calendar service not initialized.');
        }

        try {
            const response = await this.calendar.events.get({
                calendarId: this.calendarId,
                eventId: eventId,
            });

            return response.data;
        } catch (error) {
            console.error('❌ Failed to get calendar event:', error.message);
            throw error;
        }
    }

    /**
     * List upcoming events
     */
    async listUpcomingEvents(maxResults = 50) {
        if (!this.initialized) {
            throw new Error('Calendar service not initialized.');
        }

        try {
            const response = await this.calendar.events.list({
                calendarId: this.calendarId,
                timeMin: new Date().toISOString(),
                maxResults: maxResults,
                singleEvents: true,
                orderBy: 'startTime',
            });

            return response.data.items || [];
        } catch (error) {
            console.error('❌ Failed to list calendar events:', error.message);
            throw error;
        }
    }

    /**
     * Send calendar invite to client
     */
    async sendInviteToClient({ eventId, clientEmail }) {
        if (!this.initialized) {
            throw new Error('Calendar service not initialized.');
        }

        try {
            // Get existing event
            const event = await this.getEvent(eventId);

            // Add client as attendee
            const attendees = event.attendees || [];
            if (!attendees.find(a => a.email === clientEmail)) {
                attendees.push({ email: clientEmail });
            }

            // Update event with attendee
            await this.calendar.events.patch({
                calendarId: this.calendarId,
                eventId: eventId,
                resource: { attendees: attendees },
                sendUpdates: 'all', // Send invite to new attendee
            });

            console.log('✅ Calendar invite sent to:', clientEmail);
            return { success: true };

        } catch (error) {
            console.error('❌ Failed to send calendar invite:', error.message);
            throw error;
        }
    }
}

// Export singleton instance
module.exports = new CalendarService();
