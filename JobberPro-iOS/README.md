# Jobber Pro iOS App

Native iOS app for Jobber Pro field service management.

## Features

✅ **Jobs Management**
- View all jobs with status filtering
- Update job status on the go
- See job details, client info, and location
- Upload photos directly from job sites

✅ **Time Clock**
- Clock in/out with one tap
- Live timer for active sessions
- View recent time entries
- Track time per job

✅ **Schedule Calendar**
- Visual calendar of scheduled jobs
- See all jobs for any date
- Jump to job details
- View client and location info

✅ **Profile**
- User information
- Settings and preferences
- Version info
- Sign out

## Setup Instructions

### Prerequisites
- Xcode 15.0+
- iOS 17.0+
- Active Jobber Pro server account

### Installation

1. **Open in Xcode**
   - Open `JobberPro.xcodeproj` in Xcode

2. **Configure API Endpoint**
   - The app connects to: `https://jobber-pro-app-1e22b180e222.herokuapp.com`
   - To change the server, update `baseURL` in:
     - `Services/AuthManager.swift`
     - `Services/APIService.swift`

3. **Build and Run**
   - Select your device or simulator
   - Press `Cmd + R` to build and run

### First Time Setup

1. Launch the app
2. Sign in with your Jobber Pro credentials
3. Grant permissions when prompted:
   - Camera (for photo uploads)
   - Photo Library (for selecting photos)

## Project Structure

```
JobberPro/
├── JobberProApp.swift          # Main app entry point
├── Models/
│   ├── User.swift              # User data models
│   ├── Job.swift               # Job data models
│   └── TimeEntry.swift         # Time tracking models
├── Services/
│   ├── AuthManager.swift       # Authentication service
│   └── APIService.swift        # API client
└── Views/
    ├── LoginView.swift         # Login screen
    ├── MainTabView.swift       # Tab navigation
    ├── JobsListView.swift      # Jobs list
    ├── JobDetailView.swift     # Job details + photo upload
    ├── TimeClockView.swift     # Time clock
    ├── CalendarView.swift      # Schedule calendar
    └── ProfileView.swift       # User profile
```

## Architecture

- **SwiftUI** for modern, declarative UI
- **Async/Await** for clean asynchronous code
- **ObservableObject** for state management
- **URLSession** for API communication
- **PhotosUI** for photo selection

## API Integration

The app communicates with the Jobber Pro REST API:

### Authentication
- `POST /api/auth/login` - Login
- `GET /api/auth/me` - Get current user
- `POST /api/auth/logout` - Logout

### Jobs
- `GET /api/jobs` - List all jobs
- `PUT /api/jobs/:id` - Update job
- `POST /api/jobs/:id/attachments` - Upload photos

### Time Tracking
- `GET /api/timeentries` - List time entries
- `POST /api/timeclock/in` - Clock in
- `POST /api/timeclock/out` - Clock out

## Building for Production

1. **Update Bundle Identifier**
   - Set your own bundle ID in Project Settings

2. **Configure Code Signing**
   - Add your Apple Developer account
   - Select your team and provisioning profile

3. **Update API URL**
   - Point to your production server

4. **Build for Release**
   - Product → Archive
   - Upload to App Store Connect

## Testing

- Test on real devices for camera/photo features
- Test with both admin and regular user accounts
- Verify time clock accuracy
- Test photo uploads on cellular data

## Troubleshooting

**Login fails:**
- Check server URL is correct
- Verify credentials
- Check network connection

**Photos won't upload:**
- Grant Camera/Photos permissions
- Check file size limits
- Verify network connectivity

**Time clock issues:**
- Ensure you're logged in
- Check for active entry before clocking in
- Verify server time sync

## Future Enhancements

- Push notifications for new jobs
- Offline mode with sync
- Route optimization
- Client communication
- Expense tracking
- Reports and analytics

## Support

For issues or questions, contact your Jobber Pro administrator.

## License

Proprietary - All rights reserved
