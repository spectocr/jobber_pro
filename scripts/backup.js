#!/usr/bin/env node
/**
 * Nightly MongoDB → S3 backup
 * Run via Heroku Scheduler: node scripts/backup.js
 *
 * Env vars required:
 *   MONGODB_URI       — MongoDB connection string
 *   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / S3_BUCKET_NAME — same as app
 *
 * Output: s3://S3_BUCKET_NAME/backups/YYYY-MM-DD.json.gz
 * Retention: keeps last 30 days, older backups auto-deleted
 */

'use strict';

const { MongoClient } = require('mongodb');
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const zlib = require('zlib');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);

const RETENTION_DAYS = 30;

async function run() {
    const mongoUri = process.env.MONGODB_URI;
    const bucket   = process.env.S3_BUCKET_NAME;
    const keyId    = process.env.AWS_ACCESS_KEY_ID;
    const secret   = process.env.AWS_SECRET_ACCESS_KEY;

    if (!mongoUri) { console.error('❌ MONGODB_URI not set'); process.exit(1); }
    if (!bucket || !keyId || !secret) { console.error('❌ S3_BUCKET_NAME / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set'); process.exit(1); }

    const s3 = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: keyId, secretAccessKey: secret } });

    // ── 1. Connect & dump all collections ──────────────────────────────────
    const client = new MongoClient(mongoUri);
    let dump;
    try {
        await client.connect();
        const db = client.db();
        const collectionNames = (await db.listCollections().toArray()).map(c => c.name);
        console.log(`📦 Collections found: ${collectionNames.join(', ')}`);

        dump = {};
        for (const name of collectionNames) {
            const docs = await db.collection(name).find({}).toArray();
            // Convert ObjectIds and Dates to serialisable form
            dump[name] = JSON.parse(JSON.stringify(docs, (_, v) =>
                v && typeof v === 'object' && v._bsontype === 'ObjectId' ? v.toString() : v
            ));
            console.log(`  ✓ ${name}: ${docs.length} docs`);
        }
    } finally {
        await client.close();
    }

    // ── 2. Compress ────────────────────────────────────────────────────────
    const json    = JSON.stringify(dump);
    const payload = await gzip(Buffer.from(json, 'utf8'));
    const today   = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const key     = `backups/${today}.json.gz`;

    // ── 3. Upload to S3 ────────────────────────────────────────────────────
    await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: payload,
        ContentType: 'application/gzip',
        ServerSideEncryption: 'AES256',
    }));
    console.log(`✅ Backup uploaded → s3://${bucket}/${key} (${(payload.length / 1024).toFixed(1)} KB)`);

    // ── 4. Prune backups older than RETENTION_DAYS ─────────────────────────
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'backups/' }));
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400 * 1000);
    const toDelete = (listed.Contents || []).filter(obj => {
        const dateStr = obj.Key.replace('backups/', '').replace('.json.gz', '');
        return new Date(dateStr) < cutoff;
    });

    for (const obj of toDelete) {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }));
        console.log(`🗑  Deleted old backup: ${obj.Key}`);
    }

    console.log(`\n🏁 Done. ${toDelete.length} old backup(s) pruned.`);
}

run().catch(err => {
    console.error('❌ Backup failed:', err);
    process.exit(1);
});
