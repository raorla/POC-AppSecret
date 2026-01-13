#!/usr/bin/env node
/**
 * Full Secret Flow Test (APP SECRET MODE) - SIMPLIFIED
 * 
 * This script:
 * 1. Uses the Main Wallet (Owner) for all operations.
 * 2. Generates AppOrders locally (no need to publish on the marketplace).
 * 3. Runs TargetApp to push the secret.
 * 4. Runs ConsumeApp to read the secret.
 */

import { IExec, utils } from 'iexec';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Buffer } from 'buffer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env
config({ path: join(__dirname, '..', '.env') });

// Console colors
const c = {
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m',
    reset: '\x1b[0m',
    bold: '\x1b[1m'
};

function log(color, ...args) {
    console.log(color, ...args, c.reset);
}

// Configuration
const CONFIG = {
    chainId: 421614,
    rpcUrl: process.env.RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc',
    smsUrl: process.env.SMS_URL || 'https://sms.arbitrum-sepolia-testnet.iex.ec',
    targetApp: process.env.TARGET_APP_ADDRESS,
    consumeApp: process.env.CONSUME_APP_ADDRESS,
    workerpool: process.env.WORKERPOOL_ADDRESS || '0xB967057a21dc6A66A29721d96b8Aa7454B7c383F',
    // Wallet ONLY (Owner of both apps)
    privateKey: process.env.WALLET_PRIVATE_KEY
};

async function waitForTask(iexec, taskId) {
    log(c.yellow, `   ⏳ Waiting for task ${taskId.substring(0, 10)}... (This may take 1-2 min)`);

    // Wait a bit for the task to be accessible
    await new Promise(resolve => setTimeout(resolve, 5000));

    const taskObservable = await iexec.task.obsTask(taskId);

    return new Promise((resolve, reject) => {
        taskObservable.subscribe({
            next: ({ message, task }) => {
                // Filter logs to avoid spamming
                if (['TASK_COMPLETED', 'TASK_FAILED', 'TASK_TIMEDOUT'].includes(task?.statusName) || !task) {
                    log(c.cyan, `      📊 ${message}`);
                }

                if (task && task.statusName === 'COMPLETED') {
                    resolve(task);
                } else if (task && (task.statusName === 'FAILED' || task.statusName === 'TIMEDOUT')) {
                    reject(new Error(`Task ended with status ${task.statusName}`));
                }
            },
            error: (e) => {
                // Ignore temporary polling errors
                if (e && e.message && !e.message.includes('Task not found')) {
                    console.log('      (polling warn: ' + e.message + ')');
                }
            },
            complete: () => resolve()
        });
    });
}

async function fetchWorkerpoolOrder(iexec) {
    const { orders } = await iexec.orderbook.fetchWorkerpoolOrderbook({
        workerpool: CONFIG.workerpool,
        category: 0,
        minTag: 'tee,scone'
    });

    if (!orders || orders.length === 0) {
        throw new Error('No TEE workerpool order available');
    }
    return orders[0].order;
}

// Generates an App Order on the fly
async function createAppOrder(iexec, appAddress) {
    const appOrderTemplate = await iexec.order.createApporder({
        app: appAddress,
        appprice: 0,
        volume: 1,
        tag: 'tee,scone'
    });
    return await iexec.order.signApporder(appOrderTemplate);
}

// Configures permissions for TargetApp (gives it the Owner key)
async function setupTargetAppPermissions(iexec) {
    log(c.bold + c.magenta, '═══════════════════════════════════════════════════════════════');
    log(c.bold + c.magenta, '    🔧 STEP 0: TargetApp Permissions Setup');
    log(c.bold + c.magenta, '═══════════════════════════════════════════════════════════════');
    console.log('');

    const secretValue = JSON.stringify({
        DEDICATED_PRIVATE_KEY: CONFIG.privateKey,
        SMS_URL: CONFIG.smsUrl,
        RPC_URL: CONFIG.rpcUrl
    });

    log(c.yellow, '   ⚙️  Updating TargetApp configuration secret...');
    try {
        // Check if secret allows overwrite (standard behavior for SMS)
        // We force a push to ensure the app has the latest credentials
        const isPushed = await iexec.app.pushAppSecret(CONFIG.targetApp, secretValue);
        if (isPushed) {
            log(c.green, '   ✅ Configuration secret updated (TargetApp will have Owner rights)');
        } else {
            throw new Error("Push returned false");
        }
    } catch (error) {
        if (error.message && error.message.includes('already exists')) {
            log(c.yellow, '   ⚠️  Secret already exists. Assuming it is correct.');
            log(c.yellow, '       (If TargetApp test fails, redeploy TargetApp to reset the secret)');
        } else {
            log(c.red, `   ❌ Error during permission setup: ${error.message}`);
            throw error;
        }
    }
}

async function executeTargetApp(iexec, consumeAppAddress, secretName) {
    log(c.bold + c.magenta, '═══════════════════════════════════════════════════════════════');
    log(c.bold + c.magenta, '    📦 STEP 1: Running TargetApp');
    log(c.bold + c.magenta, '═══════════════════════════════════════════════════════════════');
    console.log('');
    log(c.magenta, `   🎯 Target: Push secret to ${consumeAppAddress}`);

    // 1. Create App Order locally
    const appOrder = await createAppOrder(iexec, CONFIG.targetApp);
    log(c.green, '   ✅ App order signed (local)');

    // 2. Fetch Workerpool Order
    const workerpoolOrder = await fetchWorkerpoolOrder(iexec);
    log(c.green, '   ✅ Workerpool order fetched');

    // 3. Create Request Order
    const args = `${consumeAppAddress},${secretName},api-key`;
    log(c.magenta, `   📝 Args: "${args}"`);

    const requestOrderTemplate = await iexec.order.createRequestorder({
        app: CONFIG.targetApp,
        category: 0,
        tag: 'tee,scone',
        workerpoolmaxprice: 100000000,
        params: {
            iexec_args: args
        }
    });

    const requestOrder = await iexec.order.signRequestorder(requestOrderTemplate);
    log(c.green, '   ✅ Request order signed');

    // 4. Match
    log(c.cyan, '   🚀 Starting execution (Match Orders)...');
    const { dealid } = await iexec.order.matchOrders({
        apporder: appOrder,
        workerpoolorder: workerpoolOrder,
        requestorder: requestOrder
    });

    log(c.green, `   ✅ Deal created: ${dealid}`);

    // 5. Wait
    const deal = await iexec.deal.show(dealid);
    const taskId = deal.tasks['0'];

    await waitForTask(iexec, taskId);

    const taskResult = await iexec.task.show(taskId);
    log(c.green, '   ✅ TargetApp finished!');

    return {
        dealId: dealid,
        taskId,
        resultLocation: taskResult.results?.location
    };
}

async function executeConsumeApp(iexec) {
    log(c.bold + c.magenta, '═══════════════════════════════════════════════════════════════');
    log(c.bold + c.magenta, '    📱 STEP 2: Running ConsumeApp');
    log(c.bold + c.magenta, '═══════════════════════════════════════════════════════════════');
    console.log('');
    log(c.magenta, `   🔐 Secret Source: App Secret (Global)`);

    // 1. Create App Order locally
    const appOrder = await createAppOrder(iexec, CONFIG.consumeApp);
    log(c.green, '   ✅ App order signed (local)');

    // 2. Fetch Workerpool Order
    const workerpoolOrder = await fetchWorkerpoolOrder(iexec);
    log(c.green, '   ✅ Workerpool order fetched');

    // 3. Create Request Order
    const requestOrderTemplate = await iexec.order.createRequestorder({
        app: CONFIG.consumeApp,
        category: 0,
        tag: 'tee,scone',
        workerpoolmaxprice: 100000000,
        params: {
            iexec_args: 'hash' // Request hash to verify
        }
    });

    const requestOrder = await iexec.order.signRequestorder(requestOrderTemplate);
    log(c.green, '   ✅ Request order signed');

    // 4. Match
    log(c.cyan, '   🚀 Starting execution...');
    const { dealid } = await iexec.order.matchOrders({
        apporder: appOrder,
        workerpoolorder: workerpoolOrder,
        requestorder: requestOrder
    });

    log(c.green, `   ✅ Deal created: ${dealid}`);

    // 5. Wait
    const deal = await iexec.deal.show(dealid);
    const taskId = deal.tasks['0'];

    await waitForTask(iexec, taskId);

    const taskResult = await iexec.task.show(taskId);
    log(c.green, '   ✅ ConsumeApp finished!');

    return {
        dealId: dealid,
        taskId,
        resultLocation: taskResult.results?.location
    };
}

async function fetchResult(location) {
    const ipfsUrl = `https://ipfs-gateway.arbitrum-sepolia-testnet.iex.ec${location}`;

    try {
        const response = await fetch(ipfsUrl);
        const buffer = await response.arrayBuffer();

        // The result is a ZIP, we must extract result.json
        const { execSync } = await import('child_process');
        const fs = await import('fs');

        const tempZip = `/tmp/result-${Date.now()}.zip`;
        const tempDir = `/tmp/result-${Date.now()}`;

        fs.writeFileSync(tempZip, Buffer.from(buffer));
        execSync(`mkdir -p ${tempDir} && unzip -o ${tempZip} -d ${tempDir}`, { stdio: 'pipe' });

        const resultJson = fs.readFileSync(`${tempDir}/result.json`, 'utf8');

        // Cleanup
        fs.rmSync(tempZip);
        fs.rmSync(tempDir, { recursive: true, force: true });

        return JSON.parse(resultJson);
    } catch (error) {
        console.error('Error fetching result:', error.message);
        return null;
    }
}

const LOCK_FILE = '.secret-lock.json';
const fs = await import('fs');

// Helper to manage lock state
function getLockState() {
    if (fs.existsSync(LOCK_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
            if (data.appAddress === CONFIG.consumeApp) {
                return data;
            }
        } catch (e) { /* ignore corruption */ }
    }
    return null;
}

function saveLockState(hash) {
    fs.writeFileSync(LOCK_FILE, JSON.stringify({
        appAddress: CONFIG.consumeApp,
        secretHash: hash,
        timestamp: new Date().toISOString()
    }, null, 2));
}

async function main() {
    console.log('');
    log(c.bold + c.cyan, '═══════════════════════════════════════════════════════════════');
    log(c.bold + c.cyan, '    🚀 APP SECRET FLOW TEST - STATEFUL VERIFICATION');
    log(c.bold + c.cyan, '═══════════════════════════════════════════════════════════════');
    console.log('');

    const secretName = `app-secret-test-${Date.now()}`;
    log(c.cyan, `📋 Secret Name (Meta): ${secretName}`);
    console.log('');

    // Initialize iExec
    log(c.yellow, '🔧 Initializing wallet...');

    const ethProvider = utils.getSignerFromPrivateKey(CONFIG.rpcUrl, CONFIG.privateKey);
    const iexec = new IExec(
        { ethProvider: ethProvider },
        {
            chainId: CONFIG.chainId,
            smsURL: CONFIG.smsUrl,
            resultProxyURL: 'https://ipfs-upload.arbitrum-sepolia-testnet.iex.ec',
            iexecGatewayURL: 'https://api-market.arbitrum-sepolia-testnet.iex.ec'
        }
    );

    const walletAddress = await iexec.wallet.getAddress();
    log(c.green, `   ✅ Wallet: ${walletAddress}`);
    console.log('');

    let targetAppHash, consumeAppHash;
    let existingState = getLockState();

    // STEP 0: Permissions
    await setupTargetAppPermissions(iexec);
    console.log('');

    if (existingState && existingState.secretHash) {
        log(c.bold + c.blue, '═══════════════════════════════════════════════════════════════');
        log(c.bold + c.blue, '     ℹ️  EXISTING SECRET DETECTED (Skipping Provisioning)');
        log(c.bold + c.blue, '═══════════════════════════════════════════════════════════════');
        log(c.blue, `    🔐 Known Secret Hash: ${existingState.secretHash}`);
        log(c.blue, `    🔄 Reuse existing secret (Run #${existingState.runCount ? existingState.runCount + 1 : 'N/A'})`);
        targetAppHash = existingState.secretHash;
        console.log('');
    } else {
        // STEP 1: TargetApp
        try {
            const targetResult = await executeTargetApp(iexec, CONFIG.consumeApp, secretName);
            console.log('');
            log(c.cyan, `   📁 Result: ${targetResult.resultLocation}`);

            const targetData = await fetchResult(targetResult.resultLocation);
            if (targetData) {
                targetAppHash = targetData.secretInfo?.hash;

                // Fallback for TargetApp if not explicit:
                if (!targetAppHash && targetData.generatedSecret && targetData.generatedSecret.sha256) {
                    targetAppHash = targetData.generatedSecret.sha256;
                }

                log(c.green, `   🔢 Hash TargetApp: ${targetAppHash}`);

                if (targetAppHash) {
                    saveLockState(targetAppHash);
                    log(c.green, '   💾 Secret Hash Saved to .secret-lock.json for future runs');
                }
            }
        } catch (error) {
            log(c.red, `❌ Error TargetApp: ${error.message}`);
            process.exit(1);
        }
        console.log('');
    }

    // STEP 2: ConsumeApp
    try {
        const consumeResult = await executeConsumeApp(iexec);
        console.log('');
        log(c.cyan, `   📁 Result: ${consumeResult.resultLocation}`);

        const consumeData = await fetchResult(consumeResult.resultLocation);
        if (consumeData) {
            consumeAppHash = consumeData.hashes?.sha256;
            if (consumeData.preview) {
                log(c.yellow, `   👀 Preview ConsumeApp: ${consumeData.preview}`);
            }
            log(c.green, `   🔢 Hash ConsumeApp: ${consumeAppHash}`);
        }
    } catch (error) {
        log(c.red, `❌ Error ConsumeApp: ${error.message}`);
        process.exit(1);
    }

    console.log('');

    // STEP 3: Comparison
    log(c.bold + c.cyan, '═══════════════════════════════════════════════════════════════');
    log(c.bold + c.cyan, '    🔍 HASH VERIFICATION');
    log(c.bold + c.cyan, '═══════════════════════════════════════════════════════════════');
    console.log('');

    log(c.yellow, `   Expected Hash (Provisioned): ${targetAppHash || 'Unknown'}`);
    log(c.yellow, `   Actual Hash (ConsumeApp):    ${consumeAppHash || 'N/A'}`);
    console.log('');

    if (targetAppHash && consumeAppHash && targetAppHash === consumeAppHash) {
        log(c.bold + c.green, '   ✅ HASHES MATCH!');
        log(c.green, '   ════════════════════════════════════════════════════════');
        if (existingState) {
            log(c.green, '   ✓ Confirmed: ConsumeApp is still using the ORIGINAL secret.');
            log(c.green, '   ✓ Persistent verification successful.');
        } else {
            log(c.green, '   ✓ Initial provisioning successful.');
        }
        log(c.green, '   ════════════════════════════════════════════════════════');
    } else {
        log(c.bold + c.red, '   ❌ HASH MISMATCH');
        if (!targetAppHash) {
            log(c.red, '   (Missing target hash to compare against)');
        }
    }
}

main().catch(err => {
    console.error(c.red, '❌ Fatal Error:', err.message, c.reset);
    console.error(err);
    process.exit(1);
});
