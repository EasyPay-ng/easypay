<?php
// 1. Database Configuration (Update these with your InfinityFree MySQL details later)
$db_host     = "localhost"; 
$db_user     = "your_db_username"; 
$db_password = "your_db_password"; 
$db_name     = "your_db_name"; 

// Connect to your database
$conn = new mysqli($db_host, $db_user, $db_password, $db_name);

// Check connection
if ($conn->connect_error) {
    // Log error internally, but give a clean response to the ad network
    error_log("Database connection failed: " . $conn->connect_error);
    die("ERROR: Database connection failed");
}

// 2. Capture incoming data sent by Bitco task via the URL parameters
// Example URL: postback.php?uid=123&amount=50&status=1
$user_id = isset($_GET['uid']) ? $conn->real_escape_string($_GET['uid']) : null;
$amount  = isset($_GET['amount']) ? intval($_GET['amount']) : 0;
$status  = isset($_GET['status']) ? intval($_GET['status']) : 0; // 1 usually means approved/completed

// 3. Validation
if (empty($user_id) || $amount <= 0) {
    die("ERROR: Missing required tracking parameters.");
}

// Optional security: Check if the transaction is approved (status == 1)
if ($status !== 1) {
    die("OK"); // Respond OK so they don't retry, but don't reward for a failed/reversed task
}

// 4. Update the User's balance in your database
// Adjust table name ('users') and column names ('points', 'id') to match your schema
$sql = "UPDATE users SET points = points + $amount WHERE id = '$user_id'";

if ($conn->query($sql) === TRUE) {
    // If the database updated successfully, tell Bitco task "OK"
    // Ad networks expect a standard clear text "OK" or "1" response to confirm receipt
    echo "OK";
} else {
    error_log("SQL Error: " . $conn->error);
    echo "ERROR: Failed to update balance";
}

// Close the connection
$conn->close();
?>

