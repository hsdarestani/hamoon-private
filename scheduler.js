// scheduler.js - Handles automated tasks like billing and server suspension/deletion.

require('dotenv').config(); // Load environment variables
const { isBillablePurchaseStatus } = require('./billing-status');
const {
    getToken,
    suspendServer,
    resumeServer,
    deleteServer,
    getServer
} = require('./openstack-api'); // OpenStack API functions
const {
    getAllActivePurchases,
    updatePurchaseStatus,
    updateLastBilledAt,
    getUserWallet,
    debitUser,
    recordWalletLog,
    getAllTestServers, // New: Function to get all test servers
    deleteTestServer, // New: Function to delete test server record
    getKeyPair, // Needed to delete key pair when test server is deleted
    deleteKeyPair, // Needed to delete key pair from OpenStack
    deleteKeyPairFromDb // Needed to delete key pair from DB
} = require('./db'); // Database utility functions

// Define billing cycles in hours
const BILLING_CYCLES_HOURS = {
    'hourly': 1,
    'daily': 24,
    'weekly': 24 * 7,
    'monthly': 24 * 30 // Approximate for monthly
};

/**
 * Main function to run the billing and server management logic.
 */
async function runBillingCycle() {
    console.log('Starting billing cycle check...');
    let token = null;
    try {
        token = await getToken();
    } catch (error) {
        console.error('Failed to get OpenStack token:', error.message);
        return; // Exit if token cannot be obtained
    }

    // --- Handle Purchased Servers Billing ---
    try {
        const activePurchases = await getAllActivePurchases();
        console.log(`Found ${activePurchases.length} active/suspended purchases.`);

        for (const purchase of activePurchases) {
            const { telegram_id, server_id, amount, duration, status, last_billed_at } = purchase;
            if (!isBillablePurchaseStatus(status)) continue;
            const cycleHours = BILLING_CYCLES_HOURS[duration];

            if (!cycleHours) {
                console.warn(`Unknown billing duration for server ${server_id}: ${duration}`);
                continue;
            }

            const lastBilledDate = new Date(last_billed_at);
            const now = new Date();
            const hoursSinceLastBill = (now.getTime() - lastBilledDate.getTime()) / (1000 * 60 * 60);

            // Check if billing is due (e.g., if enough time has passed since last billing)
            if (hoursSinceLastBill >= cycleHours) {
                console.log(`Billing due for server ${server_id} (User: ${telegram_id}, Cycle: ${duration}, Price: ${amount})`);

                const userBalance = await getUserWallet(telegram_id);

                if (userBalance >= amount) {
                    // Sufficient balance, debit user and resume if suspended
                    await debitUser(telegram_id, amount);
                    await recordWalletLog(telegram_id, -amount, `صورتحساب سرور ${server_id} (${duration})`, 'billed');
                    await updateLastBilledAt(server_id);
                    console.log(`Billed ${amount} from user ${telegram_id} for server ${server_id}. New balance: ${userBalance - amount}`);

                    if (status === 'suspended') {
                        try {
                            await resumeServer(token, server_id);
                            await updatePurchaseStatus(server_id, 'active');
                            console.log(`Resumed server ${server_id} for user ${telegram_id}.`);
                        } catch (e) {
                            console.error(`Error resuming server ${server_id}:`, e.message);
                            // Check if the error is a 404 (server not found)
                            if (e.response && e.response.status === 404) {
                                console.warn(`Server ${server_id} not found on OpenStack during resume. Marking purchase as 'deleted' in DB.`);
                                await updatePurchaseStatus(server_id, 'deleted'); // Mark as deleted
                            }
                            // If resume fails for other reasons, keep status as suspended or log for manual intervention
                        }
                    }
                } else {
                    // Insufficient balance, suspend server
                    console.log(`Insufficient balance for user ${telegram_id} for server ${server_id}. Current balance: ${userBalance}, Required: ${amount}`);
                    if (status === 'active') {
                        try {
                            await suspendServer(token, server_id);
                            await updatePurchaseStatus(server_id, 'suspended');
                            console.log(`Suspended server ${server_id} for user ${telegram_id}.`);
                        } catch (e) {
                            console.error(`Error suspending server ${server_id}:`, e.message);
                            // Check if the error is a 404 (server not found)
                            if (e.response && e.response.status === 404) {
                                console.warn(`Server ${server_id} not found on OpenStack during suspension. Marking purchase as 'deleted' in DB.`);
                                await updatePurchaseStatus(server_id, 'deleted'); // Mark as deleted
                            }
                            // If suspend fails for other reasons, log for manual intervention
                        }
                    } else if (status === 'suspended') {
                        console.log(`Server ${server_id} already suspended for user ${telegram_id}.`);
                    }
                }
            } else {
                console.log(`Server ${server_id} not due for billing yet. (Next billing in ${cycleHours - hoursSinceLastBill} hours)`);
            }
        }
    } catch (error) {
        console.error('Error in billing purchased servers:', error);
    }

    // --- Handle Free Test Servers Deletion ---
    try {
        console.log('Checking free test servers for expiration...');
        const testServers = await getAllTestServers();
        const ONE_HOUR_IN_MS = 60 * 60 * 1000; // 1 hour in milliseconds

        for (const testServer of testServers) {
            const { telegram_id, server_id, used_at } = testServer;
            const creationTime = new Date(used_at).getTime();
            const currentTime = new Date().getTime();
            const ageInMs = currentTime - creationTime;

            if (!server_id) { console.warn(`Skipping stale NULL test server for user ${telegram_id}`); continue; }
            if (ageInMs >= ONE_HOUR_IN_MS) {
                console.log(`Test server ${server_id} for user ${telegram_id} has expired (Age: ${ageInMs / (1000 * 60)} minutes). Deleting...`);
                try {
                    // 1. Get key pair from DB
                    const keyPair = await getKeyPair(server_id);

                    // 2. Delete server from OpenStack
                    const deleteSuccess = await deleteServer(token, server_id);
                    if (deleteSuccess) {
                        console.log(`Server ${server_id} deleted from OpenStack.`);
                    } else {
                        console.warn(`Failed to delete server ${server_id} from OpenStack. It might already be gone.`);
                    }

                    // 3. Delete key pair from OpenStack if it exists
                    if (keyPair && keyPair.key_name) {
                        try {
                            await deleteKeyPair(token, keyPair.key_name);
                            console.log(`Key pair ${keyPair.key_name} deleted from OpenStack.`);
                        } catch (keyPairError) {
                            console.warn(`Failed to delete key pair ${keyPair.key_name} from OpenStack: ${keyPairError.message}. It might already be gone.`);
                        }
                    }

                    // 4. Delete key pair record from DB
                    await deleteKeyPairFromDb(server_id);
                    console.log(`Key pair record for server ${server_id} deleted from DB.`);

                    // 5. Delete test server record from DB
                    await deleteTestServer(server_id);
                    console.log(`Test server record ${server_id} deleted from DB.`);

                } catch (e) {
                    console.error(`Error deleting expired test server ${server_id}:`, e.message);
                }
            } else {
                console.log(`Test server ${server_id} not expired yet. (Remaining: ${(ONE_HOUR_IN_MS - ageInMs) / (1000 * 60)} minutes)`);
            }
        }
    } catch (error) {
        console.error('Error in handling free test servers:', error);
    }

    console.log('Billing cycle check completed.');
}

// Run the billing cycle immediately when the scheduler starts
runBillingCycle();

// Set up a cron job to run the billing cycle every hour at minute 0
// This is typically handled by PM2's --cron option, but including for clarity
// If using PM2's --cron, this setInterval might be redundant or cause double execution.
// For PM2's --cron "0 * * * *", this part can be removed.
// setInterval(runBillingCycle, 60 * 60 * 1000); // Run every hour

