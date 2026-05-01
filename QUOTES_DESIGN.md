# Quotes/Estimates Feature Design

## Database Schema

### Quote Object
```javascript
{
  _id: ObjectId,
  quoteNumber: "Q-2026-001", // Auto-generated
  clientId: ObjectId,
  clientName: String,
  title: String,
  description: String,
  status: String, // draft, sent, approved, rejected, expired
  validUntil: Date, // Expiration date
  
  // Line items (same as jobs)
  laborItems: [{
    description: String,
    hours: Number,
    rate: Number
  }],
  materialItems: [{
    description: String,
    quantity: Number,
    price: Number
  }],
  
  // Totals
  subtotal: Number,
  taxRate: Number,
  taxWaived: Boolean,
  taxAmount: Number,
  total: Number,
  
  // Notes
  notes: String, // Internal notes
  clientNotes: String, // Shown to client
  
  // Timestamps
  createdAt: Date,
  sentAt: Date,
  approvedAt: Date,
  rejectedAt: Date,
  convertedToJobId: ObjectId, // If converted
  
  // Secure links
  secureToken: String, // UUID for public viewing
  
  createdBy: ObjectId,
  createdByName: String
}
```

## API Endpoints

- `GET /api/quotes` - List all quotes
- `POST /api/quotes` - Create quote
- `PUT /api/quotes/:id` - Update quote
- `DELETE /api/quotes/:id` - Delete quote
- `POST /api/quotes/:id/send` - Email quote to client
- `POST /api/quotes/:id/convert` - Convert approved quote to job
- `GET /quote/:token` - Public quote viewing (no auth)
- `POST /quote/:token/approve` - Client approves quote
- `POST /quote/:token/reject` - Client rejects quote

## UI Components

### Quotes View
- List of quotes with filters (status, client, date)
- Create Quote button
- Actions: View, Edit, Email, Convert to Job, Delete

### Quote Modal
- Same structure as Job modal
- Labor/materials line items
- Valid until date picker
- Internal notes vs client notes
- Status badge

### Quote Page (Public)
- Clean, professional layout
- Company branding
- Line items breakdown
- Total
- Approve/Reject buttons (if status=sent)
- "This quote has been approved" message (if approved)

## Workflow

1. **Create Quote**: Admin creates draft quote
2. **Send Quote**: Email to client with secure link
3. **Client Reviews**: Client clicks link, sees quote
4. **Client Approves**: Client clicks "Approve" button
5. **Convert to Job**: Admin converts approved quote to job
6. **Auto-populate**: Job inherits all quote details

## Email Template

Subject: Quote #{quoteNumber} from {companyName}

Body:
- Professional HTML template
- Quote summary
- Valid until date
- Link to view full quote
- Approve button (direct link)
