const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

// Initialize Firebase Admin securely
if (!getApps().length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({
    credential: cert(serviceAccount),
    databaseURL: "https://taskvault-412a0-default-rtdb.firebaseio.com"
  });
}

const db = getDatabase();

exports.handler = async (event, context) => {
  // Only allow GET requests from Bitco task
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // 1. Capture the incoming tracking parameters from Bitco task
  const { uid, amount, status } = event.queryStringParameters;

  if (!uid || !amount) {
    return { statusCode: 400, body: "ERROR: Missing required tracking parameters" };
  }

  // If the status isn't 1 (approved), stop here but acknowledge with OK
  if (parseInt(status) !== 1) {
    return { statusCode: 200, body: "OK" };
  }

  try {
    // 2. Direct reference to the user's balance based on their unique identifier key
    const balanceRef = db.ref(`users/${uid}/balance`);

    // 3. Verify the user exists before updating
    const userSnapshot = await db.ref(`users/${uid}`).once('value');
    if (!userSnapshot.exists()) {
      console.error(`User not found for identifier: ${uid}`);
      return { statusCode: 404, body: "ERROR: User not found" };
    }

    // 4. Safely update the balance using an atomic transaction
    await balanceRef.transaction((currentBalance) => {
      return (currentBalance || 0) + parseFloat(amount);
    });

    return { statusCode: 200, body: "OK" };

  } catch (error) {
    console.error("Firebase Realtime Database transaction failed: ", error);
    return { statusCode: 500, body: "ERROR: Failed to update balance" };
  }
};

