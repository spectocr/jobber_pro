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
// Pending Work Orders column (jobs + quotes)
const DEMO_WORK_ORDERS = [
    { kind: 'job',   badge: 'Job',   badgeClass: 'badge-job',   title: 'Drywall Repair — Unit 4B',           desc: 'Common-area hallway patch and paint near the Unit 8 stairwell, approx 2ft × 2ft.', meta: 'Scheduled: May 28, 2026', status: 'SCHEDULED',   statusClass: 'status-scheduled' },
    { kind: 'job',   badge: 'Job',   badgeClass: 'badge-job',   title: 'Fixture Install — Common Area Bath',  desc: '', meta: 'Scheduled: May 22, 2026', status: 'IN PROGRESS', statusClass: 'status-scheduled' },
    { kind: 'quote', badge: 'Quote', badgeClass: 'badge-quote', title: 'Kitchen Faucet Replacement — Unit 12A', desc: '', meta: 'Quote #: Q-1042 · $285.00 · Valid until 6/15/2026', status: 'PENDING REVIEW', statusClass: '' },
];
// Payment Pending column (outstanding invoices — amounts masked for the public demo)
const DEMO_PAYMENTS = [
    { title: 'Exterior Door Repair — Building A', meta: 'Invoiced: May 20, 2026', amount: '$ ●●●.●●', status: 'OUTSTANDING' },
];
// Archive tab (completed & paid)
const DEMO_ARCHIVE = [
    { badge: 'Job', badgeClass: 'badge-job', title: 'Door Hardware — Building A Entry', meta: 'Completed: May 15, 2026', status: 'COMPLETED', statusClass: 'status-completed' },
    { badge: 'Job', badgeClass: 'badge-job', title: 'Drywall Repair — Unit 7C',        meta: 'Completed: May 8, 2026',  status: 'COMPLETED', statusClass: 'status-completed' },
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
    await page.evaluate((demoName, demoWorkOrders, demoPayments, demoArchive) => {
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

        // ── Pending Work Orders column (jobs + quotes) ──
        const wo = document.getElementById('workOrdersList');
        if (wo) {
            wo.innerHTML = demoWorkOrders.map(c => `
                <div class="card">
                    <span class="card-type-badge ${c.badgeClass}">${c.badge}</span>
                    <div class="card-title">${c.title}</div>
                    ${c.desc ? `<div class="card-desc">${c.desc}</div>` : ''}
                    <div class="card-meta">${c.meta}</div>
                    <div class="card-actions">
                        <span class="status-badge ${c.statusClass}">${c.status}</span>
                        <button class="btn btn-primary" style="opacity:0.75;">${c.kind === 'quote' ? 'View Quote' : 'View Details'}</button>
                        <button class="btn btn-ghost" style="opacity:0.75;">Message</button>
                    </div>
                </div>`).join('');
        }

        // ── Payment Pending column (outstanding invoices) ──
        const pay = document.getElementById('paymentPendingList');
        if (pay) {
            pay.innerHTML = demoPayments.map(c => `
                <div class="card">
                    <span class="card-type-badge badge-job">Invoice</span>
                    <div class="card-title">${c.title}</div>
                    <div class="card-meta">${c.meta}</div>
                    <div class="card-actions">
                        <span class="status-badge" style="background:#fff5f5;color:#c53030;">${c.status}</span>
                        <span style="font-weight:700;color:#1a202c;letter-spacing:0.02em;">${c.amount}</span>
                        <button class="btn btn-primary" style="opacity:0.75;">Pay / View</button>
                    </div>
                </div>`).join('');
        }

        // ── Archive tab (completed & paid) ──
        const arch = document.getElementById('archiveList');
        if (arch) {
            arch.innerHTML = demoArchive.map(c => `
                <div class="card card-archived">
                    <span class="card-type-badge ${c.badgeClass}">${c.badge}</span>
                    <div class="card-title">${c.title}</div>
                    <div class="card-meta">${c.meta}</div>
                    <div class="card-actions">
                        <span class="status-badge ${c.statusClass}">${c.status}</span>
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
    }, DEMO_CLIENT_NAME, DEMO_WORK_ORDERS, DEMO_PAYMENTS, DEMO_ARCHIVE);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log('🚀 Starting portal screenshot capture...');

    const browser = await puppeteer.launch({
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions',
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

        // ── Screenshot 4: Archive (completed & paid) ──
        console.log('  → Shot 4: Archive...');
        await page.evaluate((demoArchive) => {
            if (window.switchTab) window.switchTab('archive');
            else { const b = document.getElementById('tab-btn-archive'); if (b) b.click(); }
            // Re-inject after the tab switch so any re-render can't blank it
            const arch = document.getElementById('archiveList');
            if (arch) arch.innerHTML = demoArchive.map(c => `
                <div class="card card-archived">
                    <span class="card-type-badge ${c.badgeClass}">${c.badge}</span>
                    <div class="card-title">${c.title}</div>
                    <div class="card-meta">${c.meta}</div>
                    <div class="card-actions"><span class="status-badge ${c.statusClass}">${c.status}</span></div>
                </div>`).join('');
            window.scrollTo(0, 0);
        }, DEMO_ARCHIVE);
        await new Promise(r => setTimeout(r, 400));
        // Capture the full portal viewport (header + tabs + Archive) so this shot
        // frames consistently with the other three, instead of a cropped panel.
        const shot4 = await page.screenshot({ type: 'jpeg', quality: 88, fullPage: false });
        await uploadScreenshot(shot4, 'portal-screenshots/04-invoices.jpg');

        // ── Write timestamp ──
        await s3.send(new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: 'portal-screenshots/last-updated.json',
            Body: JSON.stringify({ iso: new Date().toISOString() }),
            ContentType: 'application/json',
            CacheControl: 'no-cache',
        }));
        console.log('  ✅ Timestamp written');

        // ── CloudFront invalidation ──
        if (cf && CF_DIST_ID) {
            console.log('  → Invalidating CloudFront cache...');
            await cf.send(new CreateInvalidationCommand({
                DistributionId: CF_DIST_ID,
                InvalidationBatch: {
                    CallerReference: Date.now().toString(),
                    Paths: { Quantity: 5, Items: [
                        '/portal-screenshots/01-dashboard.jpg',
                        '/portal-screenshots/02-work-order.jpg',
                        '/portal-screenshots/03-ticket-confirmed.jpg',
                        '/portal-screenshots/04-invoices.jpg',
                        '/portal-screenshots/last-updated.json',
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
