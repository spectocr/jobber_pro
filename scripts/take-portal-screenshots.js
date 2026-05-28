#!/usr/bin/env node
'use strict';

/**
 * Daily portal screenshot capture.
 *
 * Logs in as a demo client, injects sanitized demo data to replace any real
 * client PII, takes 4 screenshots, and uploads to the public S3 bucket.
 * CloudFront is invalidated so gsdhandymanservice.com/portal-screenshots/*
 * serves fresh images within minutes.
 *
 * Required env vars:
 *   DEMO_CLIENT_EMAIL      — email address of the screenshot demo account
 *   DEMO_CLIENT_PASSWORD   — password of the screenshot demo account
 *   PUBLIC_S3_KEY          — AWS access key for the public S3 bucket
 *   PUBLIC_S3_SECRET       — AWS secret key for the public S3 bucket
 *   PUBLIC_S3_BUCKET       — public S3 bucket name (e.g. gsdhandymanservice.com)
 *   CLOUDFRONT_DISTRIBUTION_ID — (optional) CloudFront distribution to invalidate
 */

const puppeteer = require('puppeteer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { CloudFrontClient, CreateInvalidationCommand } = require('@aws-sdk/client-cloudfront');

// ── Config ──────────────────────────────────────────────────────────────────
const PORTAL_LOGIN_URL = 'https://app.gsdhandymanservice.com/client-login';
const DEMO_EMAIL    = process.env.DEMO_CLIENT_EMAIL;
const DEMO_PASS     = process.env.DEMO_CLIENT_PASSWORD;
const S3_BUCKET     = process.env.PUBLIC_S3_BUCKET;
const S3_KEY_ID     = process.env.PUBLIC_S3_KEY;
const S3_KEY_SECRET = process.env.PUBLIC_S3_SECRET;
const CF_DIST_ID    = process.env.CLOUDFRONT_DISTRIBUTION_ID;

// Demo data injected over any real PII before screenshotting
const DEMO_CLIENT_NAME = 'Maple Ridge Properties';
const DEMO_JOBS = [
    { title: 'Drywall Repair — Unit 4B',          date: '5/28/2026', status: 'SCHEDULED',   statusClass: 'status-scheduled'  },
    { title: 'Door Hardware — Building A Entry',   date: '5/15/2026', status: 'COMPLETED',   statusClass: 'status-completed'  },
    { title: 'Fixture Install — Common Area Bath', date: '5/22/2026', status: 'IN PROGRESS', statusClass: 'status-scheduled'  },
];
const DEMO_QUOTES = [
    { title: 'Kitchen Faucet Replacement — Unit 12A', status: 'New', statusStyle: 'background:#ebf8ff;color:#2b6cb0;' },
    { title: 'Pressure Wash — Parking Area',          status: 'Quoted', statusStyle: 'background:#fef3c7;color:#92400e;' },
];
const DEMO_INVOICES = [
    { title: 'Drywall Repair — Unit 7C', amount: '$ ●●●.●●', status: 'Paid',    statusStyle: 'background:#f0fff4;color:#276749;' },
    { title: 'Exterior Door Repair',     amount: '$ ●●●.●●', status: 'Pending', statusStyle: 'background:#fff5f5;color:#c53030;' },
];

if (!DEMO_EMAIL || !DEMO_PASS || !S3_BUCKET || !S3_KEY_ID || !S3_KEY_SECRET) {
    console.error('❌ Missing required env vars. Check DEMO_CLIENT_EMAIL, DEMO_CLIENT_PASSWORD, PUBLIC_S3_KEY, PUBLIC_S3_SECRET, PUBLIC_S3_BUCKET.');
    process.exit(1);
}

// ── AWS clients ──────────────────────────────────────────────────────────────
const s3 = new S3Client({
    region: 'us-east-1',
    credentials: { accessKeyId: S3_KEY_ID, secretAccessKey: S3_KEY_SECRET },
});
const cf = CF_DIST_ID ? new CloudFrontClient({
    region: 'us-east-1',
    credentials: { accessKeyId: S3_KEY_ID, secretAccessKey: S3_KEY_SECRET },
}) : null;

async function uploadScreenshot(buffer, key) {
    await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: 'image/jpeg',
        CacheControl: 'public, max-age=86400',
    }));
    console.log(`  ✅ Uploaded s3://${S3_BUCKET}/${key}`);
}

// ── NPI masking + demo data injection ───────────────────────────────────────
async function injectDemoData(page) {
    await page.evaluate((demoName, demoJobs, demoQuotes, demoInvoices) => {
        // Portal header title (shows client company name)
        const title = document.getElementById('portalTitle');
        if (title) title.textContent = demoName;

        // Mask any element that might show the real client name
        document.querySelectorAll('h1, .client-name, [id*="ClientName"]').forEach(el => {
            if (el.textContent.trim() && el.id !== 'portalTitle') {
                // Only replace if it looks like a name (not a section heading)
                if (el.className.includes('client') || el.id.toLowerCase().includes('name')) {
                    el.textContent = demoName;
                }
            }
        });

        // ── Jobs list ──
        const jobsList = document.getElementById('jobsList');
        if (jobsList) {
            jobsList.innerHTML = demoJobs.map(j => `
                <div class="job-card" style="display:flex;align-items:flex-start;gap:1rem;padding:0.75rem 0;border-bottom:1px solid #e2e8f0;">
                    <div style="flex:1;">
                        <p style="margin:0 0 0.2rem;font-size:0.78rem;color:#718096;">${j.date}</p>
                        <h3 style="margin:0 0 0.25rem;font-size:0.95rem;font-weight:600;color:#1a202c;">${j.title}</h3>
                        <p style="margin:0.35rem 0 0;"><span class="status-badge ${j.statusClass}" style="font-size:0.72rem;padding:2px 8px;border-radius:4px;font-weight:700;">${j.status}</span></p>
                    </div>
                    <button class="btn btn-primary" style="font-size:0.78rem;padding:0.3rem 0.85rem;white-space:nowrap;opacity:0.7;">View Details</button>
                </div>`).join('');
        }

        // ── Quotes list ──
        const quotesList = document.getElementById('quotesList');
        if (quotesList) {
            quotesList.innerHTML = demoQuotes.map(q => `
                <div class="quote-card" style="padding:0.75rem 0;border-bottom:1px solid #e2e8f0;">
                    <h3 style="margin:0 0 0.25rem;font-size:0.92rem;font-weight:600;color:#1a202c;">${q.title}</h3>
                    <span class="status-badge" style="${q.statusStyle}font-size:0.72rem;padding:2px 8px;border-radius:4px;font-weight:700;">${q.status}</span>
                </div>`).join('');
        }

        // ── Invoices list ──
        const invList = document.getElementById('invoicesList');
        if (invList) {
            invList.innerHTML = demoInvoices.map(inv => `
                <div class="invoice-card" style="display:flex;align-items:center;justify-content:space-between;padding:0.75rem 0;border-bottom:1px solid #e2e8f0;">
                    <div class="invoice-info">
                        <h3 style="margin:0 0 0.2rem;font-size:0.92rem;font-weight:600;color:#1a202c;">${inv.title}</h3>
                        <span class="status-badge" style="${inv.statusStyle}font-size:0.72rem;padding:2px 8px;border-radius:4px;font-weight:700;">${inv.status}</span>
                    </div>
                    <div style="text-align:right;">
                        <div style="font-size:1.05rem;font-weight:700;color:#1a202c;letter-spacing:0.02em;">${inv.amount}</div>
                        <button class="btn btn-primary" style="font-size:0.78rem;padding:0.25rem 0.7rem;margin-top:0.35rem;opacity:0.7;">View Invoice</button>
                    </div>
                </div>`).join('');
        }

        // Prefill the work order form to look used
        const svc = document.getElementById('qrService');
        if (svc) svc.value = 'Property Maintenance';
        const pri = document.getElementById('qrPriority');
        if (pri) pri.value = '1_week';
        const desc = document.getElementById('qrDescription');
        if (desc) desc.value = 'Common-area hallway needs drywall patch and paint touch-up near Unit 8 stairwell. Approximately 2ft × 2ft area.';

        // Show the address dropdown group as if a property is linked
        const addrGroup = document.getElementById('qrAddressGroup');
        if (addrGroup) addrGroup.style.display = '';

        // Show ticket success banner for the confirmation screenshot
        window._showTicketSuccess = () => {
            const banner = document.getElementById('quoteRequestSuccess');
            const form = document.getElementById('quoteRequestForm');
            const num = document.getElementById('newTicketNumber');
            if (banner && form && num) {
                num.textContent = 'WO-2847';
                banner.style.display = 'block';
                form.style.display = 'none';
            }
        };
    }, DEMO_CLIENT_NAME, DEMO_JOBS, DEMO_QUOTES, DEMO_INVOICES);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log('🚀 Starting portal screenshot capture...');

    const browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions',
            '--single-process',
        ],
        defaultViewport: { width: 1280, height: 820, deviceScaleFactor: 1.5 },
    });

    try {
        const page = await browser.newPage();

        // ── Login ──
        console.log('  → Logging in...');
        await page.goto(PORTAL_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.type('input[type="email"]', DEMO_EMAIL, { delay: 30 });
        await page.type('input[type="password"]', DEMO_PASS, { delay: 30 });
        await Promise.all([
            page.click('button[type="submit"]'),
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
        ]);
        await new Promise(r => setTimeout(r, 2500));

        // Bail if login failed (still on login page)
        const currentUrl = page.url();
        if (currentUrl.includes('client-login')) {
            throw new Error('Login failed — still on login page. Check DEMO_CLIENT_EMAIL and DEMO_CLIENT_PASSWORD.');
        }
        console.log('  → Logged in. Injecting demo data...');

        await injectDemoData(page);
        await new Promise(r => setTimeout(r, 400));

        // ── Screenshot 1: Dashboard overview (quotes + jobs grid) ──
        console.log('  → Shot 1: Dashboard overview...');
        await page.evaluate(() => window.scrollTo(0, 0));
        await new Promise(r => setTimeout(r, 300));
        const shot1 = await page.screenshot({ type: 'jpeg', quality: 88, fullPage: false });
        await uploadScreenshot(shot1, 'portal-screenshots/01-dashboard.jpg');

        // ── Screenshot 2: Work order submission form (pre-filled) ──
        console.log('  → Shot 2: Work order form...');
        await page.evaluate(() => {
            const el = document.getElementById('quoteRequestSection');
            if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
        });
        await new Promise(r => setTimeout(r, 400));
        const formSection = await page.$('#quoteRequestSection');
        const shot2 = formSection
            ? await formSection.screenshot({ type: 'jpeg', quality: 88 })
            : await page.screenshot({ type: 'jpeg', quality: 88, fullPage: false });
        await uploadScreenshot(shot2, 'portal-screenshots/02-work-order.jpg');

        // ── Screenshot 3: Ticket confirmed (success banner) ──
        console.log('  → Shot 3: Ticket confirmation...');
        await page.evaluate(() => {
            window._showTicketSuccess && window._showTicketSuccess();
            const el = document.getElementById('quoteRequestSection');
            if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
        });
        await new Promise(r => setTimeout(r, 300));
        const formSection3 = await page.$('#quoteRequestSection');
        const shot3 = formSection3
            ? await formSection3.screenshot({ type: 'jpeg', quality: 88 })
            : await page.screenshot({ type: 'jpeg', quality: 88, fullPage: false });
        await uploadScreenshot(shot3, 'portal-screenshots/03-ticket-confirmed.jpg');

        // ── Screenshot 4: Invoice list ──
        console.log('  → Shot 4: Invoices...');
        await page.evaluate(() => {
            const invCard = document.getElementById('invoicesList');
            if (invCard) invCard.closest('.card').scrollIntoView({ behavior: 'instant', block: 'start' });
        });
        await new Promise(r => setTimeout(r, 300));
        const invCard = await page.$('#invoicesList');
        let shot4;
        if (invCard) {
            const parent = await page.evaluateHandle(el => el.closest('.card'), invCard);
            shot4 = await parent.screenshot({ type: 'jpeg', quality: 88 });
        } else {
            shot4 = await page.screenshot({ type: 'jpeg', quality: 88, fullPage: false });
        }
        await uploadScreenshot(shot4, 'portal-screenshots/04-invoices.jpg');

        // ── CloudFront invalidation ──
        if (cf && CF_DIST_ID) {
            console.log('  → Invalidating CloudFront cache...');
            await cf.send(new CreateInvalidationCommand({
                DistributionId: CF_DIST_ID,
                InvalidationBatch: {
                    CallerReference: Date.now().toString(),
                    Paths: { Quantity: 4, Items: [
                        '/portal-screenshots/01-dashboard.jpg',
                        '/portal-screenshots/02-work-order.jpg',
                        '/portal-screenshots/03-ticket-confirmed.jpg',
                        '/portal-screenshots/04-invoices.jpg',
                    ]},
                },
            }));
            console.log('  ✅ CloudFront cache invalidated');
        }

        console.log('✅ All screenshots captured and uploaded.');
    } finally {
        await browser.close();
    }
}

main().catch(err => {
    console.error('❌ Screenshot capture failed:', err.message);
    process.exit(1);
});
