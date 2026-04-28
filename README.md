# Jobber Pro - Field Service Management System

A cloud-ready field service management system built with Node.js and MongoDB. Professional invoicing, scheduling, and client management for service businesses.

## 🌟 Features

- **Dashboard** - Real-time overview of jobs, revenue, and business metrics
- **Client Management** - Complete customer database with job history
- **Job Management** - Create detailed jobs with line items
  - Separate Labor and Materials sections
  - Multiple line items per job
  - Automatic calculations
- **Team Management** - Manage technicians and job assignments
- **Calendar View** - Visual scheduling with color-coded statuses
- **Professional Invoicing** - Branded invoices with itemization
  - Custom logo support
  - Itemized labor and materials
  - Configurable tax rates
- **Cloud Storage** - MongoDB database for scalability
- **Unsaved Changes Protection** - Never lose form data

## 🚀 Quick Start

### Local Development

1. **Clone the repository:**
```bash
git clone https://github.com/spectocr/jobber_pro.git
cd jobber_pro
git checkout mongodb-cloud
```

2. **Install dependencies:**
```bash
npm install
```

3. **Set up environment variables:**
```bash
cp .env.example .env
# Edit .env with your MongoDB connection string
```

4. **Run the server:**
```bash
npm start
```

5. **Open your browser:**
```
http://localhost:3000
```

### Cloud Deployment

See [DEPLOY.md](DEPLOY.md) for detailed deployment instructions to:
- Heroku
- Railway
- Render
- DigitalOcean
- AWS/Azure/GCP

## 📦 What's Included

### Two Versions Available

**Main Branch** (Local JSON storage):
- `jobber-pro-server.js` - Single-file app with JSON storage
- Zero dependencies
- Perfect for local/offline use
- Simple setup

**MongoDB-Cloud Branch** (This branch):
- `server.js` - Cloud-ready with MongoDB
- Scalable database
- Production-ready
- Multi-user capable

## 🗄️ Database Structure

MongoDB Collections:
- `clients` - Customer records
- `jobs` - Job records with line items
- `team` - Team member information
- `settings` - Company configuration

## 🔧 Technology Stack

- **Backend**: Node.js (native HTTP server)
- **Database**: MongoDB (Atlas or self-hosted)
- **Frontend**: Vanilla JavaScript, HTML5, CSS3
- **Deployment**: Heroku/Railway/Render compatible

## 📝 Configuration

### Environment Variables

Create a `.env` file:

```env
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/jobber_pro
PORT=3000
NODE_ENV=production
```

### MongoDB Atlas Setup

1. Create free account at https://mongodb.com/cloud/atlas
2. Create a cluster (M0 free tier)
3. Get connection string
4. Add to `.env` file

## 🎯 Usage

### First-Time Setup
1. Navigate to Settings
2. Configure company information
3. Upload company logo (optional)
4. Set tax rate
5. Add team members
6. Add clients
7. Create jobs with line items

### Creating Jobs
- Select client and team member
- Add labor items (description, hours, rate)
- Add material items (description, quantity, price)
- Totals calculate automatically

### Generating Invoices
- Click 📄 button next to any job
- Professional invoice with all line items
- Print-ready format

## 🔒 Security Notes

**Current Status**: No authentication (use in trusted environment)

**For Production Use**:
- [ ] Add user authentication
- [ ] Implement role-based access
- [ ] Enable HTTPS
- [ ] Add rate limiting
- [ ] Set up MongoDB IP whitelist
- [ ] Implement session management

See [DEPLOY.md](DEPLOY.md) for security recommendations.

## 📊 Scalability

### Free Tier Limits
- MongoDB Atlas: 512MB storage
- ~100 concurrent users
- Perfect for small businesses

### Production Recommendations
- MongoDB Atlas M10+ cluster
- Upgrade cloud platform tier
- Add Redis for caching
- Implement CDN for static assets

## 🛠️ Development

```bash
# Install dependencies
npm install

# Run in development mode with auto-reload
npm run dev

# Run in production mode
npm start
```

## 📁 Project Structure

```
jobber_pro/
├── server.js              # MongoDB version (cloud-ready)
├── jobber-pro-server.js   # JSON version (local)
├── package.json           # Dependencies
├── .env.example           # Environment template
├── Procfile              # Heroku deployment
├── README.md             # This file
├── DEPLOY.md             # Deployment guide
└── SETUP.md              # Setup instructions
```

## 🌐 Deployment Options

| Platform | Cost | Difficulty | Auto-scaling |
|----------|------|------------|--------------|
| Heroku | Free/$7+/mo | Easy | Yes |
| Railway | $5/mo credit | Easy | Yes |
| Render | Free/$7+/mo | Easy | Yes |
| DigitalOcean | $5+/mo | Medium | Manual |
| AWS/Azure/GCP | Variable | Hard | Yes |

Detailed instructions in [DEPLOY.md](DEPLOY.md)

## 🆚 JSON vs MongoDB Version

### Use JSON Version (main branch) if:
- Running locally only
- Single user
- Don't need cloud access
- Want zero dependencies

### Use MongoDB Version (mongodb-cloud branch) if:
- Need cloud/remote access
- Multiple users
- Want scalability
- Need better performance

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

MIT License - see LICENSE file for details

## 🆘 Support

- **Issues**: Open a GitHub issue
- **Deployment Help**: See [DEPLOY.md](DEPLOY.md)
- **Setup Help**: See [SETUP.md](SETUP.md)

## 🗺️ Roadmap

- [ ] User authentication
- [ ] Multi-tenant support
- [ ] Email notifications
- [ ] SMS reminders
- [ ] Payment processing (Stripe integration)
- [ ] Mobile app (React Native)
- [ ] Recurring jobs
- [ ] Estimates/Quotes
- [ ] Time tracking
- [ ] Reporting & analytics

## 💰 Cost Breakdown

### Development (FREE)
- MongoDB Atlas M0: Free
- Local development: Free
- Railway/Render free tier: Free

### Small Business (~$10-15/month)
- MongoDB Atlas M0: Free
- Heroku Hobby: $7/month
- Custom domain: $3/month

### Growing Business (~$60-80/month)
- MongoDB Atlas M10: $57/month
- Heroku Standard: $25/month
- CDN/Assets: $5-10/month

## 📸 Screenshots

Coming soon...

## ⭐ Star History

If you find this project useful, please consider giving it a star!

---

**Built with ❤️ for small service businesses**

[GitHub](https://github.com/spectocr/jobber_pro) | [Report Bug](https://github.com/spectocr/jobber_pro/issues) | [Request Feature](https://github.com/spectocr/jobber_pro/issues)
