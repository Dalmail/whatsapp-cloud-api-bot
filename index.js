const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const MONGODB_URI = process.env.MONGODB_URI;

const DB_NAME = 'daalMail';
const USERS_COLLECTION = 'users';
const NETLIFY_MENU_LINK = 'https://sweet-sopapillas-fb37b3.netlify.app/'; // Corrected variable name

let cachedDb = null;
const connectToDatabase = async () => {
  if (cachedDb) {
    console.log("connectToDatabase: Returning cached database connection");
    return cachedDb;
  }
  try {
    console.log("connectToDatabase: Connecting to MongoDB...");
    const client = await MongoClient.connect(MONGODB_URI);
    cachedDb = client.db(DB_NAME);
    console.log('connectToDatabase: Successfully connected to MongoDB');
    return cachedDb;
  } catch (error) {
    console.error('connectToDatabase: Error connecting to MongoDB:', error);
    throw error; // Re-throw the error to prevent further execution
  }
};

async function sendMessage(to, message) {
  try {
    console.log(`sendMessage: called with to: ${to}, message: ${message}`);
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        text: { body: message },
      },
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
  const location = message?.location; // Get the location

  if (!message) {
    console.log("POST /webhook: No message found in payload");
    return res.sendStatus(200);
  }

  const from = message.from;
  const msgBody = message.text?.body?.trim().toLowerCase() || '';
  console.log(`POST /webhook: from: ${from}, msgBody: ${msgBody}, location: ${JSON.stringify(location)}`); // Include location in log
  const db = await connectToDatabase();
  const usersCollection = db.collection(USERS_COLLECTION);

  if (!userState[from]) {
    userState[from] = { stage: 'start' };
  }

  const state = userState[from];
  console.log(`POST /webhook: User state for ${from}:`, state);

  if (msgBody === 'hello' || state.stage === 'start') {
    const existingUser = await usersCollection.findOne({ waNumber: from });
    if (!existingUser) {
      state.stage = 'collect_location'; // First-time user flow
      await sendMessage(from, "👋 Welcome to Daal Mail!\n\nPlease share your location to continue with your order.");
    } else {
      state.stage = 'menu'; //returning user
      await sendMessage(from, '👋 Welcome back to Daal Mail!\n\nPlease choose an option:\n1. Place an order');
    }
    return res.sendStatus(200);
  }

  if (state.stage === 'collect_location') {
    if (location) {
      state.userLocation = location;
      state.stage = 'collect_address';
      await sendMessage(from, "📍 Thank you for sharing your location. Now, please enter your address:");
      console.log(`POST /webhook:  location : ${JSON.stringify(location)}`);
    } else {
      await sendMessage(from, "❌ Location is required. Please share your location to proceed.");
    }
    return res.sendStatus(200);
  }

  if (msgBody === '1' && state.stage === 'menu') {
    const existingUser = await usersCollection.findOne({ waNumber: from });

    if (!existingUser || !Array.isArray(existingUser.previousAddresses) || existingUser.previousAddresses.length === 0) {
      state.stage = 'collect_location'; //collect location first for new user
      await sendMessage(from, '📍 No previous address found. Please share your location to continue with your order:');
    } else {
      const addresses = existingUser.previousAddresses;
      let msg = '📍 We found your previous addresses:\n\n';
      addresses.forEach((item, index) => {
        msg += `${index + 1}. ${item.address}\n`;
      });
      msg += `${addresses.length + 1}. ➕ Add a new address\n\nPlease reply with the number of your choice.`;
      state.stage = 'choose_address';
      state.addresses = addresses;
      await sendMessage(from, msg);
    }
    return res.sendStatus(200);
  }

  if (state.stage === 'choose_address') {
    const choice = parseInt(msgBody);

    if (!isNaN(choice) && choice >= 1 && choice <= state.addresses.length) {
      const selectedAddress = state.addresses[choice - 1].address;
      state.stage = 'done';
      console.log(`POST /webhook: Selected address: ${selectedAddress} for ${from}`);
      await sendMessage(from, `✅ Using your address: ${selectedAddress}`);
      await sendMessage(from, `${NETLIFY_MENU_LINK}?waNumber=${from}`); // Append waNumber here
    } else if (choice === state.addresses.length + 1) {
      state.stage = 'collect_location'; // collect location before address
      await sendMessage(from, '📍 Please share your location:');
    } else {
      await sendMessage(from, '❌ Invalid option. Please reply with a valid number from the list above.');
    }
    return res.sendStatus(200);
  }

  if (state.stage === 'collect_address') {
    const address = msgBody;
     if(state.userLocation){
        const existingUser = await usersCollection.findOne({ waNumber: from });
        const newEntry = { address, location: state.userLocation, timestamp: new Date() }; // Include the location
        if (existingUser) {
          await usersCollection.updateOne({ waNumber: from }, { $push: { previousAddresses: newEntry } });
        } else {
          const newUser = {
            waNumber: from,
            previousAddresses: [newEntry],
          }
          await usersCollection.insertOne(newUser);
        }
        state.stage = 'done';
        console.log(`POST /webhook: New address saved: ${address} for ${from}`);
        await sendMessage(from, `✅ Address saved: ${address}`);
        await sendMessage(from, `${NETLIFY_MENU_LINK}?waNumber=${from}`); // Append waNumber here
        return res.sendStatus(200);
     }
     else{
        await sendMessage(from, "❌ Location is required. Please share your location and address again.");
        state.stage = 'collect_location';
        return res.sendStatus(200);
     }
  }

  if (state.stage === 'done') {
    console.log(`POST /webhook: stage is done.  ${from}`);
    await sendMessage(from, `${NETLIFY_MENU_LINK}?waNumber=${from}`);
    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

// New route to handle order creation from Netlify
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
      return res.status(400).json({ error: 'WhatsApp number is required. Please provide it in the request body.' }); // Changed error message
    }

    const user = await usersCollection.findOne({ waNumber });
    console.log("POST /create-order: User found:", user);
    if (!user) {
      console.log("POST /create-order: WhatsApp number not found in database");
      return res.status(400).json({ error: 'WhatsApp number not found.  Please go back to WhatsApp and try again.' }); // Changed error
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

    //  Send WhatsApp confirmation
    console.log("POST /create-order: Order data before sending message:", { newOrder, waNumber, orderItems, total });
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
    console.log("POST /create-order: Exiting /create-order route");
  } catch (error) {
    console.error('POST /create-order: Error creating order:', error);
    res.status(500).json({ error: 'Failed to create order: ' + error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
