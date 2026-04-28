# Jobber Pro - Field Service Management System

A lightweight, self-hosted field service management system built with Node.js. No database required - uses JSON file storage for simplicity and portability.

## Features

- **Dashboard** - Overview of jobs, clients, revenue, and upcoming work
- **Client Management** - Track customer information and job history
- **Job Management** - Create and manage service jobs with line items
  - Separate Labor and Materials sections
  - Multiple line items per job
  - Automatic total calculation
- **Team Management** - Manage technicians and assign jobs
- **Calendar View** - Visual monthly calendar with job scheduling
- **Invoice Generation** - Professional invoices with company branding
  - Custom logo support
  - Itemized labor and materials
  - Tax calculation (configurable rate)
- **Settings** - Configure company info, tax rates, and branding
- **Unsaved Changes Protection** - Warns before losing form data

## Installation

### Prerequisites
- Node.js v14 or higher

### Quick Start

1. Clone this repository:
```bash
git clone <your-repo-url>
cd <repo-name>
```

2. Run the server:
```bash
node jobber-pro-server.js
```

3. Open your browser to `http://localhost:3000`

That's it! No npm install, no dependencies, no database setup required.

## Data Storage

All data is stored in JSON files in the `~/.jobber-pro/` directory:
- `clients.json` - Customer data
- `jobs.json` - Job records with line items
- `team.json` - Team member information
- `settings.json` - Company settings and configuration

## Usage

### First Time Setup
1. Go to Settings and configure your company information
2. Upload your company logo (optional)
3. Set your tax rate (default is 6.625% for NJ)
4. Add team members
5. Add clients
6. Create jobs with labor and material line items

### Creating Jobs with Line Items
- Click "Create Job" from Jobs or Dashboard
- Fill in basic job details
- Add labor items (description, hours, rate)
- Add material items (description, quantity, price)
- Total is calculated automatically
- Assign to team member and set status

### Generating Invoices
- Click the 📄 button next to any job
- Invoice includes all line items
- Print directly from the invoice page
- Professional formatting with your logo

## Configuration

### Tax Rate
Edit in Settings or directly in `~/.jobber-pro/settings.json`:
```json
{
  "taxRate": 0.06625
}
```

### Port Number
Default is 3000. To change, edit line 5 in `jobber-pro-server.js`:
```javascript
const PORT = 3000;
```

## Technology Stack

- **Backend**: Native Node.js HTTP server (no Express)
- **Storage**: JSON files (no database)
- **Frontend**: Vanilla JavaScript, HTML5, CSS3
- **Architecture**: Single-file application

## File Structure

```
.
├── jobber-pro-server.js    # Main application (server + frontend)
└── ~/.jobber-pro/           # Data directory
    ├── clients.json
    ├── jobs.json
    ├── team.json
    └── settings.json
```

## Browser Compatibility

Works in all modern browsers:
- Chrome/Edge (latest)
- Firefox (latest)
- Safari (latest)

## Security Notes

This is designed for **local network use** or **trusted environments**:
- No authentication system
- No encryption
- Simple file-based storage
- Runs on localhost by default

**For production use**, consider:
- Adding authentication
- Using HTTPS
- Implementing proper database
- Adding user roles/permissions

## Future Enhancements

Potential features for future development:
- Multi-user support with authentication
- Database migration (PostgreSQL, MySQL, MongoDB)
- Email notifications
- SMS reminders
- Payment processing
- Mobile app
- Cloud deployment
- Backup/restore functionality

## Contributing

This is a self-contained single-file application. To contribute:
1. Fork the repository
2. Make your changes to `jobber-pro-server.js`
3. Test thoroughly
4. Submit a pull request

## License

MIT License - feel free to use and modify for your needs.

## Support

For issues or questions, please open a GitHub issue.

---

**Note**: This is a lightweight solution for small businesses and personal use. For enterprise needs, consider dedicated field service management platforms.
