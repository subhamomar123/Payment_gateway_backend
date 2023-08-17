const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const router = express.Router();
const con = require('../config/db'); // Import the MySQL connection
require('dotenv').config();

const jwtSecretKey = process.env.JWT_SECRET_KEY;

function isPasswordComplex(password) {
    // Check for at least one special character, one capital letter, and one number
    const specialChars = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]+/;
    const capitalLetter = /[A-Z]/;
    const number = /[0-9]/;

    return specialChars.test(password) && capitalLetter.test(password) && number.test(password);
}

router.post('/createuser', async (req, res) => {
    const { username, phone_number, password } = req.body;

    try {
        // Check if user already exists
        const userExistsQuery = 'SELECT * FROM customer_info WHERE username = ? OR phone_number = ?';
        const [existingUser] = await con.promise().query(userExistsQuery, [username, phone_number]);

        if (existingUser.length > 0) {
            const conflictingField = existingUser[0].username === username ? 'username' : 'phone number';
            return res.status(400).json({ message: `The ${conflictingField} is already in use. Please provide another ${conflictingField}.` });
        }

        // Check password complexity
        if (!isPasswordComplex(password) || password.length < 8) {
            return res.status(400).json({ message: 'Password must contain at least one special character, one capital letter, and one number.' });
        }

        // Hash the password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Insert the new user into the database
        const insertUserQuery = 'INSERT INTO customer_info (username, phone_number, password) VALUES (?, ?, ?)';
        await con.promise().query(insertUserQuery, [username, phone_number, hashedPassword]);

        return res.status(201).json({ message: 'Account created successfully' });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Internal Server Error' });
    }
});

router.post('/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        // Check if the user exists
        const userQuery = 'SELECT * FROM customer_info WHERE username = ?';
        const [user] = await con.promise().query(userQuery, [username]);

        if (user.length === 0) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // Check password
        const passwordMatch = await bcrypt.compare(password, user[0].password);
        if (!passwordMatch) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // Create a JWT payload
        const payload = {
            user_id: user[0].id,
            username: user[0].username,
            phone_number: user[0].phone_number
        };

        // Create and sign the JWT
        const token = jwt.sign(payload, jwtSecretKey, { expiresIn: '6h' });

        // Send the token to the frontend
        return res.status(200).json({ token });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Internal Server Error' });
    }
});

router.post('/addaccount', async (req, res) => {
    const { token, account_no, ifsc, balance, credit_allowed, debit_allowed } = req.body;

    try {
        // Verify and decode the JWT
        const decodedToken = jwt.verify(token, jwtSecretKey);
        // Extract user information from the decoded JWT payload
        const { username, phone_number } = decodedToken;

        // Check if the account is already added for the same account number and IFSC
        const [existingAccount] = await con.promise().query('SELECT * FROM accounts_info WHERE account_number = ?', [account_no]);

        if (existingAccount.length > 0) {
            return res.status(400).json({ message: 'An account with the same account number already exists' });
        }

        // Retrieve and increment the increment_counter from customer_info table
        const [incrementResult] = await con.promise().query('SELECT increment_counter FROM customer_info WHERE username = ?', [username]);
        const increment_counter = incrementResult[0].increment_counter + 1;

        // Check if the count of accounts for the phone number is less than or equal to 10
        const [accountCountResult] = await con.promise().query('SELECT COUNT(*) AS account_count FROM accounts_info WHERE phone_number = ?', [phone_number]);
        const accountCount = accountCountResult[0].account_count;

        if (accountCount >= 10) {
            return res.status(400).json({ message: 'Maximum account limit exceeded for this phone number' });
        }

        // Generate UPI ID based on phone number, incremented counter, and 'rev'
        const upi_id = `${phone_number}.${increment_counter}@rev`;

        // Insert the new account into the database
        const insertValues = [phone_number, account_no, ifsc, upi_id, balance];
        const insertColumns = ['phone_number', 'account_number', 'ifsc_code', 'upi_id', 'balance'];

        // Check if credit_allowed and debit_allowed are provided and add to insertColumns accordingly
        if (credit_allowed !== undefined) {
            insertColumns.push('credit_allowed');
            insertValues.push(credit_allowed);
        }

        if (debit_allowed !== undefined) {
            insertColumns.push('debit_allowed');
            insertValues.push(debit_allowed);
        }

        await con.promise().query(`INSERT INTO accounts_info (${insertColumns.join(', ')}) VALUES (?, ?, ?, ?, ?${credit_allowed !== undefined ? ', ?' : ''}${debit_allowed !== undefined ? ', ?' : ''})`, insertValues);

        // Update the increment_counter in customer_info table
        await con.promise().query('UPDATE customer_info SET increment_counter = ? WHERE username = ?', [increment_counter, username]);

        return res.status(201).json({ message: 'Account added successfully', upi_id });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Internal Server Error' });
    }
});

router.post('/transaction', async (req, res) => {
    const { token, upi_id, amount, is_debit } = req.body;

    try {
        // Verify and decode the JWT
        const decodedToken = jwt.verify(token, jwtSecretKey);
        
        // Check if the account with the provided UPI ID exists
        const [accountResult] = await con.promise().query('SELECT * FROM accounts_info WHERE upi_id = ?', [upi_id]);

        if (accountResult.length === 0) {
            return res.status(404).json({ message: 'Account with the provided UPI ID not found' });
        }

        const account = accountResult[0];
        
        // Get today's date
        const currentDate = new Date();
        const todayDate = currentDate.toISOString().split('T')[0];

        if (is_debit) {
            if(!account.debit_allowed) {
                return res.status(400).json({ message: 'Debit transactions not allowed on this Account' });
            }
            // Check if the last_transaction_date is not equal to today's date
            if (account.last_transaction_date !== todayDate) {
                // Update withdrawl_limit to 100000
                account.withdrawl_limit = 100000;
            }

            // Check if the account withdrawl_limit is greater than or equal to the transaction amount
            if (account.withdrawl_limit < amount) {
                return res.status(400).json({ message: 'Transaction amount exceeds the daily limit' });
            }

            //Update last_transaction_date to today's date
            await con.promise().query('UPDATE accounts_info SET last_transaction_date = ? WHERE upi_id = ?', [todayDate, upi_id]);

            // Check if the account has enough balance for the transaction
            if (account.balance < amount) {
                return res.status(400).json({ message: 'Insufficient balance for the withdrawal' });
            }
        }

        if(!is_debit && !account.credit_allowed) {
            return res.status(400).json({ message: 'Credit transactions not allowed on this Account' });
        }

        // Update the account balance based on debit or credit
        const newBalance = is_debit ? account.balance - amount : account.balance + amount;

        // Update the account balance and withdrawl_limit in the accounts_info table
        await con.promise().query('UPDATE accounts_info SET balance = ?, withdrawl_limit = ? WHERE upi_id = ?', [newBalance, account.withdrawl_limit - amount, upi_id]);

        // Insert the transaction into the transaction_table
        const [hour, minute, second] = [currentDate.getHours(), currentDate.getMinutes(), currentDate.getSeconds()];
        const currentTime = `${hour}:${minute}:${second}`;

        const insertTransactionQuery = 'INSERT INTO transaction_table (transaction_date, transaction_time, upi_id, is_debit_transaction, transaction_amount) VALUES (?, ?, ?, ?, ?)';
        await con.promise().query(insertTransactionQuery, [todayDate, currentTime, upi_id, is_debit, amount]);

        return res.status(200).json({ message: 'Transaction successful' });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Internal Server Error' });
    }
});

router.get('/fetchbalance/:upi_id', async (req, res) => {
    const { upi_id } = req.params;
    const token = req.headers.authorization; // Assuming the JWT is sent in the Authorization header

    try {
        // Verify and decode the JWT
        const decodedToken = jwt.verify(token, jwtSecretKey);
        // Extract user information from the decoded JWT payload
        const { username } = decodedToken;

        // Check if the account with the provided UPI ID exists
        const [accountResult] = await con.promise().query('SELECT * FROM accounts_info WHERE upi_id = ?', [upi_id]);

        if (accountResult.length === 0) {
            return res.status(404).json({ message: 'Account with the provided UPI ID not found' });
        }

        const account = accountResult[0];

        // Return the balance of the account
        return res.status(200).json({ balance: account.balance });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Internal Server Error' });
    }
});

module.exports = router;

