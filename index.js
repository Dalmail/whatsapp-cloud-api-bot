const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { MongoClient } = require('mongodb');
const { v4: uuidv4 } = require('uuid'); // Import uuid for session ID generation
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const MONGODB_URI = process.env.MONGODB_URI;
// IMPORTANT: Replace with the actual URL of your deployed backend server (e.g., Heroku, Render URL)
// This is what your Netlify site will call to validate sessions.
const BACKEND_SERVER_URL = process.env.BACKEND_SERVER_URL || 'http://localhost:3000'; // Make sure this is your public URL

const DB_NAME = 'daalMail';
const USERS_COLLECTION = 'users';
const ORDERS_COLLECTION = 'orders';
// Define a new collection for sessions
const SESSIONS_COLLECTION = 'sessions';

const NETLIFY_MENU_LINK = 'https://sweet-sopapillas-fb37b3.netlify.app/';

let cachedDb = null;
const connectToDatabase = async () => {
    if (cachedDb) {
        console.log("connectToDatabase: Returning cached database connection");
        return cachedDb;
    }
    try {
        console.log("connectToDatabase: Connecting to MongoDB...");
        const client = await MongoClient.connect(MONGODB_URI);
        const db = client.db(DB_NAME);

        // Ensure TTL index for sessions for automatic cleanup
        // This will delete sessions after 10 minutes (600 seconds)
        await db.collection(SESSIONS_COLLECTION).createIndex(
            { "createdAt": 1 },
            { expireAfterSeconds: 600 } // 10 minutes
        );
        console.log('connectToDatabase: Sessions collection TTL index ensured');

        cachedDb = db;
        console.log('connectToDatabase: Successfully connected to MongoDB');
        return cachedDb;
    } catch (error) {
        console.error('connectToDatabase: Error connecting to MongoDB:', error);
        throw error;
    }
};

async function sendMessage(to, message, isInteractive = false, buttons = []) {
    try {
        console.log(`sendMessage: called with to: ${to}, message: ${message}, isInteractive: ${isInteractive}`);

        const messagePayload = isInteractive ? {
            messaging_product: 'whatsapp',
            to,
            type: 'interactive',
            interactive: {
                type: 'button',
                body: {
                    text: message
                },
                action: {
                    buttons: buttons.map((btn, index) => ({
                        type: 'reply',
                        reply: {
                            id: `btn_${index}_${btn.id || index}`,
                            title: btn.title
                        }
                    }))
                }
            }
        } : {
            messaging_product: 'whatsapp',
            to,
            text: { body: message },
        };

        await axios.post(
            `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
            messagePayload,
            {
                headers: {
                    Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                    'Content-Type': 'application/json',
                },
            }
        );
        console.log('sendMessage: successful');
    } catch (err) {
        console.error('sendMessage: Error sending message:', err.response?.data || err.message);
        throw err; // Propagate the error for handling
    }
}

async function sendListMessage(to, headerText, bodyText, buttonText, sections) {
    try {
        console.log(`sendListMessage: called with to: ${to}`);

        const messagePayload = {
            messaging_product: 'whatsapp',
            to,
            type: 'interactive',
            interactive: {
                type: 'list',
                header: {
                    type: 'text',
                    text: headerText
                },
                body: {
                    text: bodyText
                },
                action: {
                    button: buttonText,
                    sections
                }
            }
        };

        await axios.post(
            `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
            messagePayload,
            {
                headers: {
                    Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                    'Content-Type': 'application/json',
                },
            }
        );
        console.log('sendListMessage: successful');
    } catch (err) {
        console.error('sendListMessage: Error sending message:', err.response?.data || err.message);
        throw err; // Propagate the error
    }
}

app.get('/webhook', (req, res) => {
    console.log("GET /webhook: Received webhook verification request");
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    console.log(`GET /webhook: mode: ${mode}, token: ${token}, challenge: ${challenge}`);
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('GET /webhook: Webhook verification successful');
        res.status(200).send(challenge);
    } else {
        console.log('GET /webhook: Webhook verification failed');
        res.sendStatus(403);
    }
});

const userState = {};

app.post('/webhook', async (req, res) => {
    console.log("POST /webhook: Received webhook event");
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];
    const location = message?.location;
    const buttonResponse = message?.interactive?.button_reply;
    const listResponse = message?.interactive?.list_reply;

    if (!message && !buttonResponse && !listResponse) {
        console.log("POST /webhook: No message or interactive response found in payload");
        return res.sendStatus(200);
    }

    const from = message?.from || buttonResponse?.from || listResponse?.from;
    const msgBody = message?.text?.body?.trim().toLowerCase() || '';
    const buttonId = buttonResponse?.id;
    const buttonTitle = buttonResponse?.title?.toLowerCase() || '';
    const listId = listResponse?.id;
    const listTitle = listResponse?.title?.toLowerCase() || '';

    console.log(`POST /webhook: from: ${from}, msgBody: ${msgBody}, buttonId: ${buttonId}, buttonTitle: ${buttonTitle}, listId: ${listId}, listTitle: ${listTitle}, location: ${JSON.stringify(location)}`);

    const db = await connectToDatabase();
    const usersCollection = db.collection(USERS_COLLECTION);
    const ordersCollection = db.collection(ORDERS_COLLECTION);
    const sessionsCollection = db.collection(SESSIONS_COLLECTION); // Get the sessions collection

    if (!userState[from]) {
        userState[from] = { stage: 'start' };
    }

    const state = userState[from];
    console.log(`POST /webhook: User state for ${from}:`, state);

    // Handle interactive responses first
    if (buttonResponse || listResponse) {
        const responseId = buttonId || listId;
        const responseTitle = buttonTitle || listTitle;

        console.log(`Interactive response: ${responseTitle} (${responseId}) from ${from}`);

        if (state.stage === 'menu') {
            if (responseTitle.includes('place an order') || responseId.includes('place_order')) {
                await handlePlaceOrder(from, state, usersCollection, sessionsCollection); // Pass sessionsCollection
                return res.sendStatus(200);
            } else if (responseTitle.includes('track your order') || responseId.includes('track_order')) {
                await handleTrackOrder(from, state, ordersCollection);
                return res.sendStatus(200);
            }
        }

        if (state.stage === 'choose_address') {
            if (responseId.includes('address_')) {
                const index = parseInt(responseId.split('_')[1]);
                if (!isNaN(index) && state.addresses && index >= 0 && index < state.addresses.length) {
                    const selectedAddress = state.addresses[index].address;
                    state.stage = 'done';
                    console.log(`Selected address: ${selectedAddress} for ${from}`);
                    await sendMessage(from, `✅ Using your address: ${selectedAddress}`);

                    // Generate and save session ID, then send Netlify link
                    const sessionId = uuidv4();
                    const phoneNumber = from.replace('whatsapp:', '');
                    try {
                        await sessionsCollection.insertOne({ sessionId, phoneNumber, createdAt: new Date() });
                        console.log(`Session ${sessionId} created for ${phoneNumber} on address selection.`);
                        await sendMessage(from, `${NETLIFY_MENU_LINK}?sessionId=${sessionId}&phoneNumber=${phoneNumber}`);
                    } catch (error) {
                        console.error('Error creating session after address selection:', error);
                        await sendMessage(from, 'An error occurred while preparing your menu link. Please try again later.');
                    }
                    return res.sendStatus(200);
                }
            } else if (responseId.includes('new_address')) {
                state.stage = 'collect_location';
                await sendMessage(from, '📍 Please share your location:');
                return res.sendStatus(200);
            }
        }

        if (state.stage === 'track_order' && responseId.includes('order_')) {
            const index = parseInt(responseId.split('_')[1]);
            if (!isNaN(index) && state.orders && index >= 0 && index < state.orders.length) {
                const selectedOrder = state.orders[index];
                await sendMessage(from, `📦 Order Status: ${selectedOrder.status}\nOrder Number: ${selectedOrder.orderNumber}\nOrder Time: ${selectedOrder.orderTime}`);
                state.stage = 'done';
                delete userState[from];
                await sendMessage(from, "Please send 'hi' or 'hello' to restart.");
                return res.sendStatus(200);
            }
        }
    }

    // Handle text messages (fallback)
    if (msgBody === 'hello' || msgBody === 'hi' || state.stage === 'start') {
        const existingUser = await usersCollection.findOne({ waNumber: from });

        // Generate and save session ID FIRST for "hello" or "hi"
        const sessionId = uuidv4();
        const phoneNumber = from.replace('whatsapp:', ''); // Ensure clean phone number
        try {
            await sessionsCollection.insertOne({ sessionId, phoneNumber, createdAt: new Date() });
            console.log(`Session ${sessionId} created for ${phoneNumber} on initial hello/hi.`);
        } catch (error) {
            console.error('Error creating session on hello/hi:', error);
            await sendMessage(from, 'An error occurred. Please try again later.');
            return res.sendStatus(500); // Return error if session cannot be created
        }

        if (!existingUser) {
            state.stage = 'collect_location';
            await sendMessage(from, "👋 Welcome to Daal Mail!\n\nPlease share your location to continue with your order.");
        } else {
            state.stage = 'menu';
            await sendMessage(
                from,
                '👋 Welcome back to Daal Mail!\n\nPlease choose an option:',
                true,
                [
                    { title: 'Place an order', id: 'place_order' },
                    { title: 'Track your order', id: 'track_order' }
                ]
            );
        }
        return res.sendStatus(200);
    } else if (state.stage === 'start') {
        await sendMessage(from, "Please send 'hi' or 'hello' to start.");
        return res.sendStatus(200);
    }

    if (state.stage === 'collect_location') {
        if (location) {
            state.userLocation = location;
            state.stage = 'collect_address';
            await sendMessage(from, "📍 Thank you for sharing your location. Now, please enter your address:");
            console.log(`Location received: ${JSON.stringify(location)}`);
        } else {
            await sendMessage(from, "❌ Location is required. Please share your location to proceed.");
        }
        return res.sendStatus(200);
    }

    if (msgBody === '1' && state.stage === 'menu') {
        await handlePlaceOrder(from, state, usersCollection, sessionsCollection); // Pass sessionsCollection
        return res.sendStatus(200);
    } else if (msgBody === '2' && state.stage === 'menu') {
        await handleTrackOrder(from, state, ordersCollection);
        return res.sendStatus(200);
    } else if (state.stage === 'menu') {
        await sendMessage(from, "Invalid option. Please choose 1 or 2.");
        return res.sendStatus(200);
    }

    if (state.stage === 'track_order' && state.orders) {
        const orderNumberChoice = parseInt(msgBody);
        if (!isNaN(orderNumberChoice) && orderNumberChoice > 0 && orderNumberChoice <= state.orders.length) {
            const selectedOrder = state.orders[orderNumberChoice - 1];
            await sendMessage(from, `📦 Order Status: ${selectedOrder.status}\nOrder Number: ${selectedOrder.orderNumber}\nOrder Time: ${selectedOrder.orderTime}`);
            state.stage = 'done';
            delete userState[from];
            await sendMessage(from, "Please send 'hi' or 'hello' to restart.");
            return res.sendStatus(200);
        } else {
            await sendMessage(from, "❌ Invalid order number. Please enter a valid number from the list.");
            return res.sendStatus(200);
        }
    } else if (state.stage === 'track_order') {
        await sendMessage(from, "❌ Invalid input. Please enter a valid order number from the list.");
        return res.sendStatus(200);
    }

    if (state.stage === 'choose_address') {
        const choice = parseInt(msgBody);
        if (!isNaN(choice) && choice >= 1 && choice <= state.addresses.length) {
            const selectedAddress = state.addresses[choice - 1].address;
            state.stage = 'done';
            console.log(`Selected address: ${selectedAddress} for ${from}`);
            await sendMessage(from, `✅ Using your address: ${selectedAddress}`);

            // Generate and save session ID, then send Netlify link
            const sessionId = uuidv4();
            const phoneNumber = from.replace('whatsapp:', '');
            try {
                await sessionsCollection.insertOne({ sessionId, phoneNumber, createdAt: new Date() });
                console.log(`Session ${sessionId} created for ${phoneNumber} on address selection.`);
                await sendMessage(from, `${NETLIFY_MENU_LINK}?sessionId=${sessionId}&phoneNumber=${phoneNumber}`);
            } catch (error) {
                console.error('Error creating session after address selection:', error);
                await sendMessage(from, 'An error occurred while preparing your menu link. Please try again later.');
            }
        } else if (choice === state.addresses.length + 1) {
            state.stage = 'collect_location';
            await sendMessage(from, '📍 Please share your location:');
        } else {
            await sendMessage(from, '❌ Invalid option. Please reply with a valid number from the list above.');
        }
        return res.sendStatus(200);
    }

    if (state.stage === 'collect_address') {
        const address = msgBody;
        if (state.userLocation) {
            const existingUser = await usersCollection.findOne({ waNumber: from });
            const newEntry = { address, location: state.userLocation, timestamp: new Date() };
            if (existingUser) {
                await usersCollection.updateOne({ waNumber: from }, { $push: { previousAddresses: newEntry } });
            } else {
                const newUser = {
                    waNumber: from,
                    previousAddresses: [newEntry],
                };
                await usersCollection.insertOne(newUser);
            }
            state.stage = 'done';
            console.log(`New address saved: ${address} for ${from}`);
            await sendMessage(from, `✅ Address saved: ${address}`);

            // Generate and save session ID, then send Netlify link
            const sessionId = uuidv4();
            const phoneNumber = from.replace('whatsapp:', '');
            try {
                await sessionsCollection.insertOne({ sessionId, phoneNumber, createdAt: new Date() });
                console.log(`Session ${sessionId} created for ${phoneNumber} on new address collection.`);
                await sendMessage(from, `${NETLIFY_MENU_LINK}?sessionId=${sessionId}&phoneNumber=${phoneNumber}`);
            } catch (error) {
                console.error('Error creating session on new address collection:', error);
                await sendMessage(from, 'An error occurred while preparing your menu link. Please try again later.');
            }
            return res.sendStatus(200);
        } else {
            await sendMessage(from, "❌ Location is required. Please share your location and address again.");
            state.stage = 'collect_location';
            return res.sendStatus(200);
        }
    }

    if (state.stage === 'done') {
        console.log(`Conversation completed for ${from}`);
        delete userState[from]; // Clear state after completion

        // Even for 'done' stage, if we are sending the link, it should be session-validated
        const sessionId = uuidv4();
        const phoneNumber = from.replace('whatsapp:', '');
        try {
            await sessionsCollection.insertOne({ sessionId, phoneNumber, createdAt: new Date() });
            console.log(`Session ${sessionId} created for ${phoneNumber} on done stage.`);
            await sendMessage(from, `${NETLIFY_MENU_LINK}?sessionId=${sessionId}&phoneNumber=${phoneNumber}`);
        } catch (error) {
            console.error('Error creating session on done stage:', error);
            await sendMessage(from, 'An error occurred while preparing your menu link. Please try again later.');
        }
        return res.sendStatus(200);
    }

    res.sendStatus(200);
});

// Helper function for handling place order flow - FIXED to handle WhatsApp button limit
async function handlePlaceOrder(from, state, usersCollection, sessionsCollection) { // Added sessionsCollection
    const existingUser = await usersCollection.findOne({ waNumber: from });
    if (!existingUser || !Array.isArray(existingUser.previousAddresses) || existingUser.previousAddresses.length === 0) {
        state.stage = 'collect_location';
        await sendMessage(from, '📍 No previous address found. Please share your location to continue with your order:');
        return;
    }

    const addresses = existingUser.previousAddresses;

    // Store addresses in state
    state.stage = 'choose_address';
    state.addresses = addresses;

    if (addresses.length <= 2) {
        // Use buttons only if we have 2 or fewer addresses (saving 1 button for "Add new address")
        let msg = '📍 We found your previous addresses:\n\n';
        addresses.forEach((item, index) => {
            msg += `${index + 1}. ${item.address}\n`;
        });

        const buttons = addresses.map((item, index) => ({
            title: `Address ${index + 1}`,
            id: `address_${index}`
        }));

        buttons.push({ title: '➕ Add new address', id: 'new_address' });

        await sendMessage(from, msg, true, buttons);
    } else {
        // Use a simple numbered list for 3+ addresses
        let msg = '📍 We found your previous addresses:\n\n';
        addresses.forEach((item, index) => {
            msg += `${index + 1}. ${item.address}\n`;
        });
        msg += `\n${addresses.length + 1}. Add new address`;

        await sendMessage(from, msg, false);
    }
}

// Helper function for handling track order flow
async function handleTrackOrder(from, state, ordersCollection) {
    state.stage = 'track_order';
    const waNumberForQuery = from.startsWith('+') ? from : `+${from}`;
    console.log(`Tracking orders for waNumber: ${waNumberForQuery}`);
    const userOrders = await ordersCollection.find({ waNumber: waNumberForQuery }).toArray();

    if (userOrders.length > 0) {
        if (userOrders.length <= 3) {
            // Use buttons for 3 or fewer orders
            const buttons = userOrders.map((order, index) => ({
                title: `Order ${index + 1}`,
                id: `order_${index}`
            }));

            let orderListMessage = "📦 Your Previous Orders:\n";
            userOrders.forEach((order, index) => {
                orderListMessage += `${index + 1}. Order Number: ${order.orderNumber}\n`;
            });

            await sendMessage(
                from,
                orderListMessage + "\nPlease select an order to track:",
                true,
                buttons
            );
        } else {
            // Use text list for more than 3 orders
            let orderListMessage = "📦 Your Previous Orders:\n";
            userOrders.forEach((order, index) => {
                orderListMessage += `${index + 1}. Order Number: ${order.orderNumber}\n`;
            });
            orderListMessage += "\nPlease reply with the number of the order you want to track:";
            await sendMessage(from, orderListMessage);
        }
        state.orders = userOrders;
    } else {
        await sendMessage(from, "❌ No previous orders found.");
        state.stage = 'done';
    }
}

// --- NEW API Endpoint for Session Validation ---
app.post('/validate-session', async (req, res) => {
    console.log('POST /validate-session: Received session validation request');
    const { sessionId, phoneNumber } = req.body;

    if (!sessionId || !phoneNumber) {
        console.log('POST /validate-session: Missing session ID or phone number.');
        return res.status(400).json({ valid: false, message: 'Missing session ID or phone number.' });
    }

    try {
        const db = await connectToDatabase();
        const sessionsCollection = db.collection(SESSIONS_COLLECTION);

        // Mongoose's `expires` index (TTL index) handles session expiration.
        // If a session is found, it means it's still active (within 10 minutes).
        const session = await sessionsCollection.findOne({ sessionId, phoneNumber });

        if (session) {
            console.log(`POST /validate-session: Session ${sessionId} for ${phoneNumber} is valid.`);
            res.status(200).json({ valid: true, message: 'Session is valid. Displaying menu.' });
        } else {
            console.log(`POST /validate-session: Session ${sessionId} for ${phoneNumber} invalid or expired.`);
            res.status(200).json({ valid: false, message: 'Session invalid or expired. Please go back to WhatsApp and say "hello" to restart the process.' });
        }
    } catch (error) {
        console.error('POST /validate-session: Error validating session:', error);
        res.status(500).json({ valid: false, message: 'An internal server error occurred during session validation.' });
    }
});


// Order creation endpoint
app.post('/create-order', async (req, res) => {
    console.log("POST /create-order: Entered /create-order route");
    try {
        const db = await connectToDatabase();
        const ordersCollection = db.collection('orders');
        const usersCollection = db.collection('users');

        const { orderItems, total, waNumber } = req.body;
        console.log("POST /create-order: Received data:", { orderItems, total, waNumber });

        if (!waNumber) {
            console.log("POST /create-order: WhatsApp number is missing");
            return res.status(400).json({ error: 'WhatsApp number is required. Please provide it in the request body.' });
        }

        const user = await usersCollection.findOne({ waNumber });
        console.log("POST /create-order: User found:", user);
        if (!user) {
            console.log("POST /create-order: WhatsApp number not found in database");
            return res.status(400).json({ error: 'WhatsApp number not found. Please go back to WhatsApp and try again.' });
        }

        const newOrder = {
            waNumber,
            orderItems,
            total,
            status: 'notified',
            orderTime: new Date(),
            orderNumber: `DM${Math.floor(Math.random() * 1000000)}`,
        };

        const result = await ordersCollection.insertOne(newOrder);
        console.log("POST /create-order: Order saved to database:", result);

        res.status(201).json({
            message: 'Order created successfully',
            order: newOrder,
        });

        const orderSummary = `
Order Summary:
Order Number: ${newOrder.orderNumber}
Total: ${total}
Items:
${orderItems.map(item => `- ${item.name} x ${item.quantity}`).join('\n')}
Status: ${newOrder.status}
        `;
        console.log("POST /create-order: Order summary: ", orderSummary);
        try {
            await sendMessage(waNumber, `Your order has been placed!\n${orderSummary}`);
            console.log("POST /create-order: sendMessage call successful");
        } catch (e) {
            console.error("POST /create-order: Error sending message from create-order", e);
        }
    } catch (error) {
        console.error('POST /create-order: Error creating order:', error);
        res.status(500).json({ error: 'Failed to create order: ' + error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));