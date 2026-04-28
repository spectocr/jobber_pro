# Deployment Guide - Cloud Version with MongoDB

This guide covers deploying Jobber Pro to various cloud platforms with MongoDB.

## Prerequisites

1. **MongoDB Atlas Account** (Free tier available)
   - Sign up at https://www.mongodb.com/cloud/atlas
   - Create a free cluster
   - Get your connection string

2. **Cloud Platform Account** (choose one):
   - Heroku (easiest)
   - Railway
   - Render
   - DigitalOcean App Platform
   - AWS/Azure/GCP

## Step 1: Set Up MongoDB Atlas

1. Go to https://cloud.mongodb.com/
2. Create a new project: "Jobber Pro"
3. Create a free cluster (M0 Sandbox)
4. Wait for cluster to be created (~5 minutes)
5. Click "Connect" → "Connect your application"
6. Copy the connection string:
   ```
   mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
7. Replace `<password>` with your actual password
8. Add `/jobber_pro` before the `?` to specify the database name:
   ```
   mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/jobber_pro?retryWrites=true&w=majority
   ```

## Step 2: Deploy to Heroku (Recommended for Beginners)

### Install Heroku CLI
Download from https://devcenter.heroku.com/articles/heroku-cli

### Deploy Steps

```bash
# Login to Heroku
heroku login

# Create a new Heroku app
heroku create your-jobber-pro

# Set environment variables
heroku config:set MONGODB_URI="your-mongodb-connection-string"
heroku config:set NODE_ENV=production

# Deploy
git push heroku mongodb-cloud:main

# Open your app
heroku open
```

Your app will be live at: `https://your-jobber-pro.herokuapp.com`

## Step 3: Deploy to Railway

1. Go to https://railway.app/
2. Click "New Project" → "Deploy from GitHub repo"
3. Select your `jobber_pro` repository
4. Select the `mongodb-cloud` branch
5. Add environment variables:
   - `MONGODB_URI`: Your MongoDB connection string
   - `NODE_ENV`: production
6. Railway will automatically deploy

Your app will be live at: `https://your-app.railway.app`

## Step 4: Deploy to Render

1. Go to https://render.com/
2. Click "New" → "Web Service"
3. Connect your GitHub repository
4. Configure:
   - **Branch**: mongodb-cloud
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
5. Add environment variables:
   - `MONGODB_URI`: Your MongoDB connection string
   - `NODE_ENV`: production
6. Click "Create Web Service"

Your app will be live at: `https://your-app.onrender.com`

## Environment Variables Required

Create a `.env` file locally (for testing) or set in your cloud platform:

```env
MONGODB_URI=mongodb+srv://username:password@cluster0.xxxxx.mongodb.net/jobber_pro?retryWrites=true&w=majority
PORT=3000
NODE_ENV=production
```

## Testing Locally with MongoDB

1. Install dependencies:
```bash
npm install
```

2. Create `.env` file with your MongoDB connection string

3. Run the server:
```bash
npm start
```

4. Open http://localhost:3000

## MongoDB Collections Structure

The app will automatically create these collections:

- **clients**: Customer information
- **jobs**: Job records with line items (laborItems, materialItems)
- **team**: Team member/technician records
- **settings**: Company settings and configuration

## Security Notes

⚠️ **IMPORTANT**: This version has no authentication yet.

For production use, you should:

1. Add user authentication
2. Set up IP whitelisting in MongoDB Atlas
3. Use environment variables for all secrets
4. Enable HTTPS (most platforms do this automatically)
5. Add rate limiting
6. Implement session management

## Monitoring

### MongoDB Atlas
- Monitor database usage in Atlas dashboard
- Set up alerts for storage/connection limits

### Application Logs
```bash
# Heroku
heroku logs --tail

# Railway
View logs in Railway dashboard

# Render
View logs in Render dashboard
```

## Backup Strategy

MongoDB Atlas automatically backs up your data (even on free tier).

To export data manually:
1. Go to MongoDB Atlas dashboard
2. Click "..." on your cluster
3. Select "Command Line Tools"
4. Use `mongodump` or export via Compass

## Scaling

Free tiers should handle:
- Up to 500 MB storage
- ~100 concurrent users
- Basic usage for small business

To scale:
1. Upgrade MongoDB Atlas cluster (M10+ for production)
2. Upgrade cloud platform tier
3. Consider adding Redis for caching
4. Implement connection pooling

## Troubleshooting

### Cannot connect to MongoDB
- Check MongoDB Atlas network access (allow all IPs: 0.0.0.0/0)
- Verify connection string format
- Check username/password are correct

### App crashes on startup
```bash
# Check logs
heroku logs --tail

# Common issues:
# - Missing MONGODB_URI environment variable
# - Invalid MongoDB connection string
# - Port binding issues (use process.env.PORT)
```

### Data not persisting
- Verify MongoDB connection is successful (check logs)
- Check MongoDB Atlas has storage available
- Ensure write operations aren't being blocked

## Cost Estimates

### Free Tier (Development/Small Business)
- MongoDB Atlas M0: **FREE** (512MB storage)
- Heroku Hobby: **FREE** (sleeps after 30 min inactivity)
- Railway: **$5/month credit** (then pay-as-you-go)
- Render: **FREE** (slower cold starts)

### Production Tier (Growing Business)
- MongoDB Atlas M10: **$57/month** (10GB storage)
- Heroku Standard: **$25-50/month**
- Railway: **~$10-20/month** (pay for usage)
- Render: **$7-25/month**

## Next Steps

After deployment:

1. Set up custom domain
2. Configure SSL (usually automatic)
3. Set up monitoring/alerts
4. Implement authentication
5. Add backup automation
6. Set up staging environment

## Support

For deployment issues:
- MongoDB Atlas: https://www.mongodb.com/docs/atlas/
- Heroku: https://devcenter.heroku.com/
- Railway: https://docs.railway.app/
- Render: https://render.com/docs
