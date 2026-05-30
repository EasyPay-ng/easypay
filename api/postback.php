<?php
// 1. Database Configuration (Update these with your InfinityFree MySQL details)
$db_host     = "localhost"; 
$db_user     = "your_db_username"; 
$db_password = "your_db_password"; 
$db_name     = "your_db_name"; 

// Connect to your database
$conn = new mysqli($db_host, $db_user, $db_password, $db_name);

if ($conn->connect_error) {
    error_log("Database connection failed: " . $conn->connect_error);
    die("ERROR: Database connection failed");
}

// 2. Capture incoming data sent by Bitco task
$user_id = isset($_GET['uid']) ? $conn->real_escape_string($_GET['uid']) : null;
$status  = isset($_GET['status']) ? intval($_GET['status']) : 0; // 1 = approved

// --- REWARD HANDLING ---
// If your 'balance' column holds decimals (e.g. 0.50), use floatval(). 
// If it stores whole numbers/points, change floatval to intval.
$amount  = isset($_GET['amount']) ? floatval($_GET['amount']) : 0.0;

// 3. Validation
if (empty($user_id) || $amount <= 0) {
    die("ERROR: Missing required tracking parameters.");
}

// If the status is not approved (e.g., a chargeback or click validation), 
// we say "OK" so they don't keep retrying, but we don't credit the user.
if ($status !== 1) {
    die("OK"); 
}

// 4. Update the User's balance in your database
// Updated column name from 'points' to 'balance'
$sql = "UPDATE users SET balance = balance + $amount WHERE id = '$user_id'";

if ($conn->query($sql) === TRUE) {
    // If the database updated successfully, respond with a clean "OK"
    echo "OK";
} else {
    error_log("SQL Error: " . $conn->error);
    echo "ERROR: Failed to update balance";
}

$conn->close();
?>
