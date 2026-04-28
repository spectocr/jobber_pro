# Quick Setup Guide

## Installation

1. **Clone the repository:**
```bash
git clone https://github.com/yourusername/jobber-pro.git
cd jobber-pro
```

2. **Start the server:**
```bash
node jobber-pro-server.js
```

Or using npm:
```bash
npm start
```

3. **Open your browser:**
```
http://localhost:3000
```

That's it! No npm install needed - this app has **zero dependencies**.

## First-Time Configuration

### 1. Configure Company Settings
- Click "Settings" in the navigation
- Enter your company name, address, phone, email
- Upload your company logo (optional)
- Set your tax rate (default: 6.625%)
- Click "Save Settings"

### 2. Add Team Members
- Click "Team" in the navigation
- Click "+ Add Team Member"
- Enter name, role, contact info
- Repeat for all technicians

### 3. Add Clients
- Click "Clients" in the navigation
- Click "+ Add Client"
- Enter customer information
- Click "Save Client"

### 4. Create Your First Job
- Click "Jobs" in the navigation
- Click "+ Create Job"
- Select client and assign team member
- Add labor line items (description, hours, rate)
- Add material line items (description, quantity, price)
- Set status and scheduled date
- Click "Save Job"

## Daily Usage

### Creating Jobs
1. Go to Jobs → "+ Create Job"
2. Fill in details and add line items
3. System auto-calculates totals

### Generating Invoices
1. Find the job in Jobs list or Client detail view
2. Click the 📄 button
3. Invoice opens in new tab with all line items
4. Click "Print Invoice" button

### Viewing Schedule
- Click "Calendar" to see monthly view
- Jobs color-coded by status
- Click any date to see job details

### Tracking Revenue
- Dashboard shows monthly revenue
- Upcoming jobs section (clickable)
- Status breakdown

## Data Location

All data is stored in: `~/.jobber-pro/`

**On Windows:** `C:\Users\YourName\.jobber-pro\`  
**On Mac/Linux:** `/home/yourname/.jobber-pro/`

Files:
- `clients.json` - Customer records
- `jobs.json` - Job records with line items
- `team.json` - Team members
- `settings.json` - Company settings and logo

## Backup Your Data

Simply copy the `.jobber-pro` folder to backup all your data:

```bash
# Backup
cp -r ~/.jobber-pro ~/jobber-pro-backup-2026-04-28

# Restore
cp -r ~/jobber-pro-backup-2026-04-28 ~/.jobber-pro
```

## Troubleshooting

### Port Already in Use
If port 3000 is taken, edit `jobber-pro-server.js` line 5:
```javascript
const PORT = 3001; // Change to any available port
```

### Data Not Saving
Check that the `~/.jobber-pro/` directory exists and is writable.

### Invoice Not Showing Logo
1. Go to Settings
2. Upload logo again (max 500KB)
3. Click "Save Settings"
4. Refresh the page

### Jobs Not Loading in Dashboard
Click "Jobs" first to load the job list, then return to Dashboard.

## Need Help?

Open an issue on GitHub with:
- Your operating system
- Node.js version (`node --version`)
- Description of the problem
- Screenshots if applicable
