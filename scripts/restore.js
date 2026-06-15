#!/usr/bin/env node
/**
 * MongoDB restore from S3 backup
 * Usage: node scripts/restore.js YYYY-MM-DD
 *
 * Env vars required (same as app):
 *   MONGODB_URI, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_BUCKET_NAME
 *
 * WARNING: This REPLACES all data in each collection with the backup snapshot.
 * It will prompt for confirmation before writing anything.
 */

'use strict';

const { MongoClient, ObjectId } = require('mongodb');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const zlib = require('zlib');
const { promisify } = require('util');
const readline = require('readline');

const gunzip = promisify(zlib.gunzip);

async function confirm(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        rl.question(question, answer => { rl.close(); resolve(answer.trim().toLowerCase()); });
    });
}

async function run() {
    const dateArg = process.argv[2];
    if (!dateArg || !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
        console.error('Usage: node scripts/restore.js YYYY-MM-DD');
        console.error('Example: node scripts/restore.js 2026-06-15');
        process.exit(1);
    }

    const mongoUri = process.env.MONGODB_URI;
    const bucket   = process.env.S3_BUCKET_NAME;
    const keyId    = process.env.AWS_ACCESS_KEY_ID;
    const secret   = process.env.AWS_SECRET_ACCESS_KEY;

    if (!mongoUri) { console.error('❌ MONGODB_URI not set'); process.exit(1); }
    if (!bucket || !keyId || !secret) { console.error('❌ S3_BUCKET_NAME / AWS credentials not set'); process.exit(1); }

    const s3Key = `backups/${dateArg}.json.gz`;

    // ── 1. Download backup from S3 ──────────────────────────────────────────
    console.log(`\n📥 Downloading s3://${bucket}/${s3Key} ...`);
    const s3 = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: keyId, secretAccessKey: secret } });
    let compressed;
    try {
        const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key }));
        const chunks = [];
        for await (const chunk of res.Body) chunks.push(chunk);
        compressed = Buffer.concat(chunks);
    } catch (e) {
        if (e.name === 'NoSuchKey') {
            console.error(`❌ No backup found for ${dateArg}. Check available backups in S3 under backups/`);
        } else {
            console.error('❌ S3 download failed:', e.message);
        }
        process.exit(1);
    }

    // ── 2. Decompress & parse ───────────────────────────────────────────────
    const json = (await gunzip(compressed)).toString('utf8');
    const dump = JSON.parse(json);
    const collections = Object.keys(dump);
    const totalDocs   = Object.values(dump).reduce((sum, docs) => sum + docs.length, 0);

    console.log(`\n📦 Backup contents:`);
    for (const [name, docs] of Object.entries(dump)) {
        console.log(`   ${name}: ${docs.length} docs`);
    }
    console.log(`\n   Total: ${totalDocs} documents across ${collections.length} collections`);

    // ── 3. Confirm ──────────────────────────────────────────────────────────
    console.log(`\n⚠️  WARNING: This will REPLACE all data in the following collections:`);
    console.log(`   ${collections.join(', ')}`);
    console.log(`\n   Current live data will be overwritten with the ${dateArg} snapshot.`);
    const answer = await confirm('\nType "yes" to continue, anything else to abort: ');
    if (answer !== 'yes') {
        console.log('\n🛑 Aborted — no changes made.');
        process.exit(0);
    }

    // ── 4. Restore ──────────────────────────────────────────────────────────
    const client = new MongoClient(mongoUri);
    try {
        await client.connect();
        const db = client.db();

        for (const [name, docs] of Object.entries(dump)) {
            process.stdout.write(`   Restoring ${name}... `);
            await db.collection(name).deleteMany({});
            if (docs.length > 0) {
                const prepared = docs.map(doc => {
                    try {
                        if (doc._id && typeof doc._id === 'string' && doc._id.length === 24) {
                            doc._id = new ObjectId(doc._id);
                        }
                    } catch (e) {}
                    return doc;
                });
                await db.collection(name).insertMany(prepared, { ordered: false });
            }
            console.log(`✓ ${docs.length} docs`);
        }
    } finally {
        await client.close();
    }

    console.log(`\n✅ Restore complete. Database is now at the ${dateArg} snapshot.`);
    console.log(`   Restart the app (heroku restart) to clear any in-memory caches.\n`);
}

run().catch(err => {
    console.error('\n❌ Restore failed:', err.message);
    process.exit(1);
});
