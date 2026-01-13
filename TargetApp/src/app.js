#!/usr/bin/env node

/**
 * Secret Generator iApp for iExec - AUTO PUSH APP SECRET VERSION

 * 
 * This iApp generates secure secrets and AUTOMATICALLY pushes them to the 
 * Secret Management Service (SMS) using a dedicated private key stored in App Secret.
 * 
 * The secret is pushed to SMS and can be consumed by ConsumeApp without
 * anyone (developer or user) ever seeing the secret value.
 * 
 * Usage:
 *   args: "secretName,secretType"
 *   - secretName: Name to identify the secret in SMS
 *   - secretType: Type of secret (api-key, password, token, random, uuid)
 */

import { randomBytes, createHash } from 'crypto';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { IExec, utils } from 'iexec';
import { isAddress } from 'ethers';

// Environment variables provided by iExec TEE
const IEXEC_OUT = process.env.IEXEC_OUT || './output';
const APP_DEVELOPER_SECRET = process.env.IEXEC_APP_DEVELOPER_SECRET;
// The default target Consume App address should be passed in args or env, but we can set a placeholder
const DEFAULT_CONSUME_APP = process.env.CONSUME_APP_ADDRESS;

// Default SMS URL for Arbitrum Sepolia
const DEFAULT_SMS_URL = 'https://sms.arbitrum-sepolia-testnet.iex.ec';
const DEFAULT_RPC_URL = 'https://sepolia-rollup.arbitrum.io/rpc';
const CHAIN_ID = 421614;

/**
 * Generate a secure random string
 */
function generateRandomString(length, charset = 'alphanumeric') {
    const charsets = {
        alphanumeric: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
        alphanumericSpecial: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}|;:,.<>?',
        hex: '0123456789abcdef',
        numeric: '0123456789',
        alpha: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
    };

    const chars = charsets[charset] || charsets.alphanumeric;
    const bytes = randomBytes(length);
    let result = '';

    for (let i = 0; i < length; i++) {
        result += chars[bytes[i] % chars.length];
    }

    return result;
}

/**
 * Generate a UUID v4
 */
function generateUUID() {
    const bytes = randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Generate secret based on type
 */
function generateSecret(secretType) {
    const timestamp = new Date().toISOString();
    let secretValue;
    let metadata = {};

    switch (secretType.toLowerCase()) {
        case 'api-key':
            const prefix = generateRandomString(4, 'alpha').toLowerCase();
            const key = generateRandomString(32, 'alphanumeric');
            secretValue = `${prefix}_${key}`;
            metadata = { format: 'prefix_key', keyLength: 32 };
            break;

        case 'password':
            secretValue = generateRandomString(24, 'alphanumericSpecial');
            metadata = { format: 'strong_password', length: 24, hasSpecialChars: true };
            break;

        case 'token':
            const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
            const payload = Buffer.from(JSON.stringify({
                iat: Math.floor(Date.now() / 1000),
                jti: generateUUID()
            })).toString('base64url');
            const signature = randomBytes(32).toString('base64url');
            secretValue = `${header}.${payload}.${signature}`;
            metadata = { format: 'jwt-like' };
            break;

        case 'uuid':
            secretValue = generateUUID();
            metadata = { format: 'uuid-v4' };
            break;

        case 'hex':
            secretValue = randomBytes(32).toString('hex');
            metadata = { format: 'hex', bits: 256 };
            break;

        case 'private-key':
            secretValue = '0x' + randomBytes(32).toString('hex');
            metadata = { format: 'ethereum-compatible', bits: 256 };
            break;

        case 'random':
        default:
            secretValue = randomBytes(32).toString('base64');
            metadata = { format: 'base64', bytes: 32 };
            break;
    }

    const secretHash = createHash('sha256').update(secretValue).digest('hex');

    return {
        secret: secretValue,
        hash: secretHash,
        type: secretType,
        generatedAt: timestamp,
        metadata
    };
}

/**
 * Parse App Secret configuration
 */
function parseAppSecret() {
    if (!APP_DEVELOPER_SECRET) {
        return null;
    }

    try {
        const config = JSON.parse(APP_DEVELOPER_SECRET);
        return {
            privateKey: config.DEDICATED_PRIVATE_KEY,
            smsUrl: config.SMS_URL || DEFAULT_SMS_URL,
            rpcUrl: config.RPC_URL || DEFAULT_RPC_URL
        };
    } catch (error) {
        console.error('❌ Failed to parse App Secret:', error.message);
        return null;
    }
}

/**
 * Push App Secret to SMS
 */
async function pushSecretToSMS(targetAppAddress, secretName, secretValue, config) {
    console.log('📤 Pushing App Secret to SMS...');
    console.log(`   SMS URL: ${config.smsUrl}`);
    console.log(`   Target App: ${targetAppAddress}`);

    if (!targetAppAddress || !isAddress(targetAppAddress)) {
        return {
            success: false,
            error: 'Invalid or missing Consume App Address. Cannot push App Secret.'
        };
    }

    try {
        // Create ethProvider from private key
        const ethProvider = utils.getSignerFromPrivateKey(
            config.rpcUrl,
            config.privateKey
        );

        // Initialize iExec SDK
        const iexec = new IExec(
            { ethProvider },
            {
                chainId: CHAIN_ID,
                smsURL: config.smsUrl
            }
        );

        // Get the address associated with the private key
        const walletAddress = await iexec.wallet.getAddress();
        console.log(`   Owner Wallet: ${walletAddress}`);

        // Note: For App Secret, checkAppSecretExists usually checks if *any* secret is set.
        // But simply overwriting is the standard behavior for App Secret updates if allowed.
        // We will try to push directly.

        // Information about App Secret:
        // App Secret is NOT named. It is bound to the App Address.
        // Setting it overwrites the previous one.

        console.log(`   ⚠️  Pushing App Secret will overwrite any existing secret for ${targetAppAddress}`);

        const isPushed = await iexec.app.pushAppSecret(targetAppAddress, secretValue);

        if (isPushed) {
            console.log(`   ✅ App Secret pushed successfully!`);
            return {
                success: true,
                secretName: "IEXEC_APP_DEVELOPER_SECRET", // It's always this name in the env
                address: walletAddress
            };
        } else {
            throw new Error("Failed to push App Secret (SDK returned false)");
        }

    } catch (error) {
        console.error(`   ❌ Failed to push secret: ${error.message}`);
        console.error(`      Ensure ${config.privateKey ? 'the wallet' : 'it'} is the owner of ${targetAppAddress}`);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Parse command line arguments
 */
function parseArgs(args) {
    const argString = args.join(' ').trim();

    if (!argString) {
        return {
            secretName: `secret-${Date.now()}`,
            secretType: 'random'
        };
    }

    const parts = argString.split(',').map(p => p.trim());

    // Check if first arg looks like an address
    if (parts[0] && parts[0].startsWith('0x')) {
        return {
            consumeAppAddress: parts[0],
            secretName: parts[1] || `secret-${Date.now()}`,
            secretType: parts[2] || 'random'
        };
    }

    return {
        // Fallback for backward compatibility or if address is missing
        // Warning: This might map "my-secret" to address if not careful, 
        // but we prioritize structure: address, name, type
        consumeAppAddress: null,
        secretName: parts[0] || `secret-${Date.now()}`,
        secretType: parts[1] || 'random'
    };
}

/**
 * Main function
 */
async function main() {
    console.log('🔐 Secret Generator iApp - AUTO PUSH');
    console.log('=====================================');
    console.log('Running inside iExec TEE environment');
    console.log('');

    // Parse App Secret configuration
    const appConfig = parseAppSecret();

    if (!appConfig || !appConfig.privateKey) {
        console.error('❌ No App Secret configured!');
        console.error('');
        console.error('📌 This iApp requires an App Secret with:');
        console.error('   {');
        console.error('     "DEDICATED_PRIVATE_KEY": "0x...",');
        console.error('     "SMS_URL": "https://sms..."');
        console.error('   }');

        const output = {
            success: false,
            error: 'App Secret not configured',
            instructions: 'Deploy this iApp with an App Secret containing DEDICATED_PRIVATE_KEY'
        };

        if (!existsSync(IEXEC_OUT)) mkdirSync(IEXEC_OUT, { recursive: true });
        writeFileSync(join(IEXEC_OUT, 'result.json'), JSON.stringify(output, null, 2));
        writeFileSync(join(IEXEC_OUT, 'computed.json'), JSON.stringify({ 'deterministic-output-path': join(IEXEC_OUT, 'result.json') }));

        return;
    }

    console.log('✅ App Secret found');
    console.log('');

    // Parse arguments
    const args = process.argv.slice(2);
    const { consumeAppAddress, secretName, secretType } = parseArgs(args);

    // Use default or parsed address
    const targetAddress = consumeAppAddress || DEFAULT_CONSUME_APP;

    console.log(`📋 Configuration:`);
    console.log(`   Consume App: ${targetAddress || 'Not specified (Simulation mode)'}`);
    console.log(`   Secret Name: ${secretName} (Not used for App Secret indexing, purely metadata)`);
    console.log(`   Secret Type: ${secretType}`);
    console.log('');

    // Generate the secret
    console.log('🎲 Generating secret...');
    const secretData = generateSecret(secretType);

    console.log(`✅ Secret generated!`);
    console.log(`   Type: ${secretData.type}`);
    console.log(`   Hash (SHA-256): ${secretData.hash}`);
    console.log('');

    // Push secret to SMS
    let pushResult = { success: false, error: 'No Consume App Address provided' };

    if (targetAddress) {
        pushResult = await pushSecretToSMS(targetAddress, secretName, secretData.secret, appConfig);
    } else {
        console.log('⚠️  Skipping push: No Consume App Address provided in arguments.');
        console.log('   Usage: iapp run ... --args "0xConsumeAppAddress,secretName,secretType"');
    }

    // Prepare output (never expose the secret value!)
    const output = {
        success: pushResult.success,
        secretName: pushResult.secretName || secretName,
        dedicatedAddress: pushResult.address,
        secretInfo: {
            hash: secretData.hash,
            type: secretData.type,
            generatedAt: secretData.generatedAt,
            metadata: secretData.metadata
        },
        smsInfo: {
            pushed: pushResult.success,
            error: pushResult.error || null
        },
        consumeInstructions: {
            description: 'To use this secret in ConsumeApp:',
            requesterAddress: pushResult.address,
            secretType: 'App Secret (Global)',
            note: 'The secret is set as the App Owner Secret for the Consume App.'
        }
    };

    // Ensure output directory exists
    if (!existsSync(IEXEC_OUT)) {
        mkdirSync(IEXEC_OUT, { recursive: true });
    }

    // Write the result
    const resultPath = join(IEXEC_OUT, 'result.json');
    writeFileSync(resultPath, JSON.stringify(output, null, 2));

    // Write computed.json for iExec
    const computedPath = join(IEXEC_OUT, 'computed.json');
    writeFileSync(computedPath, JSON.stringify({ 'deterministic-output-path': resultPath }));

    console.log('');
    console.log('📁 Output written to:', resultPath);
    console.log('');

    if (pushResult.success) {
        console.log('🎉 Secret generation and push complete!');
        console.log('');
        console.log('📌 The secret is now in SMS and can be used by ConsumeApp');
        console.log('   Nobody (dev or user) has seen the secret value!');
    } else {
        console.log('⚠️ Secret was generated but push to SMS failed');
        console.log('   Error:', pushResult.error);
    }
}

// Run the main function
main().catch(error => {
    console.error('❌ Error:', error.message);
    process.exit(1);
});
