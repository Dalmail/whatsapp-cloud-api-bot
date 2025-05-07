// index.js
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
const NETLIFY_MENU_LINK = 'https://sweet-sopapillas-fb37b3.netlify.app/';

let cachedDb = null;
const connectToDatabase = async () => {
  if (cachedDb) return cachedDb;
  try {
    const client = await MongoClient.connect(MONGODB_URI);
    cachedDb = client.db(DB_NAME);
    console.log('Successfully connected to MongoDB');
    return cachedDb;
  } catch (error) {
    console.error('Error connecting to MongoDB:', error);
    throw error; // Re-throw the error to prevent further execution
  }
};

async function sendMessage(to, message) {
  try {
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
  } catch (err) {
    console.error('Error sending message:', err.response?.data || err.message);
  }
}

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

const userState = {};

app.post('/webhook', async (req, res) => {
  const entry = req.body.entry?.[0];
  const changes = entry?.changes?.[0];
  const message = changes?.value?.messages?.[0];

  if (!message) return res.sendStatus(200);

  const from = message.from;
  const msgBody = message.text?.body?.trim().toLowerCase() || '';
  const db = await connectToDatabase();
  const usersCollection = db.collection(USERS_COLLECTION);

  if (!userState[from]) {
    userState[from] = { stage: 'start' };
  }

  const state = userState[from];
  console.log(`Message from ${from}: ${msgBody}, State: ${state.stage}`);

  if (msgBody === 'hello' || state.stage === 'start') {
    state.stage = 'menu';
    await sendMessage(from, '👋 Welcome to Daal Mail!\n\nPlease choose an option:\n1. Place an order');
    return res.sendStatus(200);
  }

  if (msgBody === '1' && state.stage === 'menu') {
    console.log(`Handling option 1 for ${from}`);
    const existingUser = await usersCollection.findOne({ waNumber: from });
    console.log('Existing user:', existingUser);

    if (!existingUser || !Array.isArray(existingUser.previousAddresses) || existingUser.previousAddresses.length === 0) {
      state.stage = 'collect_address';
      await sendMessage(from, '📍 Please share your address to proceed with your order.');
    } else {
      const prevAddr = existingUser.previousAddresses[0].address;
      await sendMessage(from, `📦 We found your previous address:\n${prevAddr}\n\nTo continue ordering, visit: ${NETLIFY_MENU_LINK}?waNumber=${from}`); // Append waNumber
      state.stage = 'done';
    }
    return res.sendStatus(200);
  }

  if (state.stage === 'collect_address') {
    const address = msgBody;
    const newUserData = {
      waNumber: from,
      previousAddresses: [
        {
          address,
          location: null,
        },
      ],
    };
    console.log('Saving new user data:', newUserData);
    try {
      await usersCollection.insertOne(newUserData);
      state.stage = 'done';
      await sendMessage(from, `✅ Address saved!\n\nNow you can order from our menu here: ${NETLIFY_MENU_LINK}`);
      return res.sendStatus(200);
    } catch (error) {
      console.error('Error inserting user data:', error);
      await sendMessage(from, '⚠️ There was an error saving your address. Please try again.');
      return res.sendStatus(500);
    }
  }

  res.sendStatus(200);
});

// New route to handle order creation from Netlify
app.post('/create-order', async (req, res) => {
  try {
    const db = await connectToDatabase();
    const ordersCollection = db.collection('orders');
    const usersCollection = db.collection('users');

    const { orderItems, total, waNumber } = req.body;

    if (!waNumber) {
      return res.status(400).json({ error: 'WhatsApp number is required' });
    }

    const user = await usersCollection.findOne({ waNumber });
    if (!user) {
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

    res.status(201).json({
      message: 'Order created successfully',
      order: newOrder,
    });

    //  Send WhatsApp confirmation
    const orderSummary = `
Order Summary:
Order Number: ${newOrder.orderNumber}
Total: ${total}
Items:
${orderItems.map(item => `- ${item.name} x ${item.quantity}`).join('\n')}
Status: ${newOrder.status}
    `;
    await sendMessage(waNumber, `Your order has been placed!\n${orderSummary}`);


  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({ error: 'Failed to create order: ' + error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook running on port ${PORT}`));
